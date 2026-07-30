import postgres from 'postgres';

export const POSTGRES_STATEMENT_TIMEOUT_MS = 22_000;
export const POSTGRES_LOCK_TIMEOUT_MS = 2_000;

let singleton;
let singletonUrl;

function publicDbError(error) {
  if (error?.code === '55P03') return new Error('server_busy');
  if (error?.code === '57014') return new Error('scan_deadline_exceeded');
  return error;
}

export function executeDbQuery(query, context = {}) {
  const now = typeof context?.now === 'function' ? context.now : Date.now;
  const signal = context?.signal;
  const deadline = Number(context?.deadline);
  if (signal?.aborted) return Promise.reject(new Error('request_aborted'));
  if (Number.isFinite(deadline) && now() >= deadline) return Promise.reject(new Error('scan_deadline_exceeded'));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let running;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const succeed = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(publicDbError(error));
    };
    const cancelAndFail = code => {
      if (settled) return;
      try { running?.cancel?.(); } catch { /* cancellation remains best effort */ }
      fail(new Error(code));
    };
    const onAbort = () => cancelAndFail('request_aborted');

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    if (Number.isFinite(deadline)) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        cancelAndFail('scan_deadline_exceeded');
        return;
      }
      timer = setTimeout(() => cancelAndFail('scan_deadline_exceeded'), remaining);
    }

    try {
      running = typeof query?.execute === 'function' ? query.execute() : query;
      running.then(succeed, fail);
    } catch (error) {
      fail(error);
    }
  });
}

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('missing_env:DATABASE_URL');
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    connection: {
      application_name: 'recherche-dirigeants-scan',
      statement_timeout: POSTGRES_STATEMENT_TIMEOUT_MS,
      lock_timeout: POSTGRES_LOCK_TIMEOUT_MS,
    },
  });
  return {
    async rateLimit(identifierHash, maximum, seconds = 60, context) {
      const [row] = await executeDbQuery(
        sql`select consume_scan_rate_limit(${identifierHash}, ${maximum}, ${seconds}) as allowed`,
        context,
      );
      return Boolean(row.allowed);
    },
    async reserveUpstreamSlot(limiterKey, intervalMs, context) {
      const [row] = await executeDbQuery(
        sql`select reserve_upstream_slot(${limiterKey}, ${intervalMs}) as wait_ms`,
        context,
      );
      return Number(row.wait_ms);
    },
    async historyPage({ snapshotTime, cursorTime = '', cursorKey = '', limit = 500 }, context) {
      const query = cursorTime
        ? sql`
            select lead_key, payload_snapshot, delivered_at
            from lead_deliveries
            where delivered_at <= ${snapshotTime}::timestamptz
              and (delivered_at, lead_key) < (${cursorTime}::timestamptz, ${cursorKey})
            order by delivered_at desc, lead_key desc
            limit ${limit}`
        : sql`
            select lead_key, payload_snapshot, delivered_at
            from lead_deliveries
            where delivered_at <= ${snapshotTime}::timestamptz
            order by delivered_at desc, lead_key desc
            limit ${limit}`;
      return executeDbQuery(query, context);
    },
    async createScan(queryHash, filters, target, context) {
      const [row] = await executeDbQuery(sql`
        insert into scans(query_hash, filters, target_count)
        values(${queryHash}, ${sql.json(filters)}, ${target})
        returning id`, context);
      return row.id;
    },
    async storedLeadsPage({ snapshotTime, cursorTime = '', cursorKey = '', limit = 500 }, context) {
      const query = cursorTime
        ? sql`
            select lead_key, director_fingerprint, person_name_fingerprint, fingerprint_version,
                   identity_quality, birth_year, company_siren, payload, first_seen_at
            from leads
            where first_seen_at <= ${snapshotTime}::timestamptz
              and (first_seen_at, lead_key) > (${cursorTime}::timestamptz, ${cursorKey})
            order by first_seen_at asc, lead_key asc
            limit ${limit}`
        : sql`
            select lead_key, director_fingerprint, person_name_fingerprint, fingerprint_version,
                   identity_quality, birth_year, company_siren, payload, first_seen_at
            from leads
            where first_seen_at <= ${snapshotTime}::timestamptz
            order by first_seen_at asc, lead_key asc
            limit ${limit}`;
      return executeDbQuery(query, context);
    },
    async cachedPage(queryHash, page, context) {
      const rows = await executeDbQuery(sql`
        select response, fetched_at
        from api_cache_pages
        where query_hash = ${queryHash} and page = ${page}`, context);
      return rows[0] || null;
    },
    async claimPage(queryHash, page, owner, leaseSeconds = 30, context) {
      const [row] = await executeDbQuery(
        sql`select claim_cache_page(${queryHash}, ${page}, ${owner}, ${leaseSeconds}) as claimed`,
        context,
      );
      return Boolean(row.claimed);
    },
    async storePage(queryHash, page, request, response, fetchedAt, context) {
      await executeDbQuery(sql`
        insert into api_cache_pages(query_hash, page, request, response, fetched_at)
        values(${queryHash}, ${page}, ${sql.json(request)}, ${sql.json(response)}, ${fetchedAt}::timestamptz)
        on conflict(query_hash, page) do nothing`, context);
    },
    async releasePage(queryHash, page, owner, context) {
      await executeDbQuery(
        sql`delete from cache_page_locks where query_hash = ${queryHash} and page = ${page} and owner = ${owner}`,
        context,
      );
    },
    async reserve(scanId, candidates, limit, context) {
      return executeDbQuery(
        sql`select * from reserve_scan_leads(${scanId}, ${sql.json(candidates)}, ${limit})`,
        context,
      );
    },
    async finishScan(id, count, warning = '', context) {
      await executeDbQuery(sql`
        update scans
        set status = case when ${warning} <> '' or ${count} < target_count then 'partial' else 'completed' end,
            result_count = ${count}, warning = ${warning}, completed_at = now()
        where id = ${id} and status = 'running'`, context);
    },
    async failScan(id, warning, context) {
      if (id) await executeDbQuery(sql`
        update scans
        set status = 'failed', warning = ${warning}, completed_at = now()
        where id = ${id} and status = 'running'`, context);
    },
    async close() {
      await sql.end();
    },
  };
}

export function getDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('missing_env:DATABASE_URL');
  if (!singleton) {
    singleton = createDb(url);
    singletonUrl = url;
  } else if (singletonUrl !== url) {
    throw new Error('database_url_changed');
  }
  return singleton;
}

export async function closeDb() {
  if (!singleton) return;
  const database = singleton;
  singleton = undefined;
  singletonUrl = undefined;
  await database.close();
}
