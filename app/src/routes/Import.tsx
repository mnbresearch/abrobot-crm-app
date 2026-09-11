import { useRef, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, useToast } from "../components/ui";

// CSV import. Parsing is done here rather than pulling in a library — the
// format is simple and a dependency for one screen isn't worth it. Handles
// quoted fields, embedded commas and escaped quotes.

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(cell); cell = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = []; cell = "";
      continue;
    }
    cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

const TARGETS = [
  { key: "", label: "— skip —" },
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "target_country", label: "Target country" },
  { key: "course", label: "Course" },
  { key: "course_level", label: "Course level" },
  { key: "intake", label: "Intake" },
  { key: "budget_inr", label: "Budget" },
];

/** Guess a mapping from the header text. */
function guess(header: string): string {
  const h = header.toLowerCase().replace(/[^a-z]/g, "");
  if (/^(name|fullname|customer|student|patient|client)$/.test(h)) return "name";
  if (h.includes("email") || h.includes("mail")) return "email";
  if (h.includes("phone") || h.includes("mobile") || h.includes("contact")) return "phone";
  if (h.includes("country")) return "target_country";
  if (h.includes("courselevel") || h.includes("level")) return "course_level";
  if (h.includes("course") || h.includes("program")) return "course";
  if (h.includes("intake")) return "intake";
  if (h.includes("budget")) return "budget_inr";
  return "";
}

/** PostgREST's hosted max-rows default. There is no supabase/config.toml in
 *  this repo, so this is what any single unbounded select is silently cut to. */
const MAX_ROWS = 1000;

export function Import({ navigate }: { navigate: (to: string) => void }) {
  const { org, ui, profile, stages, fields } = useApp();
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<string[]>([]);
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; phase: string } | null>(null);
  // A refusal BEFORE anything is written, as opposed to a report afterwards.
  const [blocked, setBlocked] = useState<{ title: string; detail: string; upgrade: boolean } | null>(null);
  const [result, setResult] = useState<{
    inserted: number;
    duplicates: number;
    failed: number;               // rows we skipped: no email and no phone
    rejected: number;             // rows the database refused — a different thing
    notAttempted: number;         // rows after the failure, never sent
    rejectReason: string | null;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const onFile = async (f: File) => {
    const text = await f.text();
    const parsed = parseCsv(text);
    if (parsed.length < 2) { toast.error("That file has no data rows"); return; }
    setFilename(f.name);
    setRows(parsed);
    setMapping(parsed[0].map(guess));
    setResult(null);
  };

  const customKeys = new Set(fields.map((f) => f.key));

  const run = async () => {
    if (!org || rows.length < 2) return;
    setBusy(true);
    setBlocked(null);

    const header = mapping;
    const body = rows.slice(1);
    const firstStage = stages[0]?.key ?? "new";

    // ── 1. pre-flight the plan allowance ──────────────────────────────────
    // Without this, a 1,500-row file into a Starter org (1,000 cap) committed
    // 1,000 rows and lost 500 — with no record of WHICH 500, so the only
    // recovery was to re-import the whole file and rely on dedupe. Asking the
    // server what is left costs one RPC and turns a partial, unrecoverable
    // write into a refusal the customer can act on.
    setProgress({ done: 0, total: body.length, phase: "Checking your plan" });
    const { data: snap, error: snapErr } = await supabase.rpc("usage_snapshot", { p_org_id: org.id });
    if (snapErr) {
      setBusy(false);
      setProgress(null);
      toast.error(`Could not check your plan allowance: ${snapErr.message}. Nothing was imported.`);
      return;
    }
    const usage = snap as { plan?: string; not_activated?: boolean; is_expired?: boolean; leads?: { used: number; limit: number | null } } | null;
    const used = usage?.leads?.used ?? 0;
    const cap = usage?.leads?.limit ?? null;
    const remaining = cap === null ? Infinity : Math.max(0, cap - used);

    // Refuse immediately only when there is provably no room for anything. The
    // precise check happens after deduplication, below: duplicates and rows
    // with no contact details are never inserted, so testing the raw row count
    // here would turn away a 1,500-row file that is 600 duplicates and would
    // have fitted comfortably.
    if (remaining === 0) {
      setBusy(false);
      setProgress(null);
      setBlocked({
        title: `Your plan has no room for new ${ui.leadNounPlural.toLowerCase()}`,
        detail: `Your ${usage?.plan ?? "current"} plan allows ${cap === null ? "unlimited" : cap.toLocaleString("en-IN")} records and you already have ${used.toLocaleString("en-IN")}. Nothing has been imported — your file is untouched.`,
        upgrade: true,
      });
      return;
    }

    // ── 2. build the duplicate index ──────────────────────────────────────
    // Pull existing contacts once — cheaper and more reliable than a query
    // per row, and it lets us report duplicates honestly.
    // Two bugs here, both silent. The error was discarded, so on failure
    // `existing` was null, both dedupe sets came out empty, and EVERY row was
    // imported as new while the result card confidently reported "0 duplicates
    // skipped". And `.limit(50000)` did NOT lift the cap — PostgREST clamps to
    // max-rows (1,000 here) regardless of what the client asks for, so for any
    // org past a thousand records the comparison set was the newest 1,000 and
    // every older contact re-imported as a fresh duplicate. Paged properly now.
    const seenEmail = new Set<string>();
    const seenPhone = new Set<string>();
    // An absolute stop. The loop's only exit was an empty page, which is
    // exactly what a proxy that ignores Range never returns — it re-serves page
    // one forever and the browser tab locks up behind a progress bar with no
    // way out but killing it. 200 pages is 200,000 contacts, past the largest
    // plan, so reaching it means something is wrong rather than that the org is
    // big. Same class of bug as the export loop in store.tsx.
    const MAX_DUPE_PAGES = 200;
    // Contacts EXAMINED, not the size of the two sets added together. A contact
    // with both an email and a phone lands in both, so `seenEmail.size +
    // seenPhone.size` counted it twice and the progress readout sailed past
    // 100% of the org's own record count.
    let scanned = 0;
    let from = 0;
    let finished = false;
    for (let page = 0; page < MAX_DUPE_PAGES; page++) {
      setProgress({ done: Math.min(scanned, used), total: used, phase: "Checking for duplicates" });
      const { data: rows, error: dupeErr } = await supabase
        .from("leads").select("email, phone").eq("org_id", org.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + MAX_ROWS - 1);
      if (dupeErr) {
        setBusy(false);
        setProgress(null);
        toast.error(`Could not check for duplicates: ${dupeErr.message}. Nothing was imported.`);
        return;
      }
      const batch = rows ?? [];
      if (batch.length === 0) { finished = true; break; }
      for (const e of batch) {
        if (e.email) seenEmail.add(e.email.toLowerCase());
        if (e.phone) seenPhone.add(e.phone);
      }
      scanned += batch.length;
      // Advance by what came back, never by MAX_ROWS — if the real cap is
      // lower than assumed, a fixed step skips whole blocks of contacts and
      // they re-import as duplicates.
      from += batch.length;
    }
    // Refuse rather than import against a half-built index: an incomplete
    // duplicate set silently re-imports contacts the customer already has, and
    // the result card would report "0 duplicates skipped" while doing it.
    if (!finished) {
      setBusy(false);
      setProgress(null);
      toast.error("Could not finish checking for duplicates — the server kept returning the same page. Nothing was imported.");
      return;
    }

    let inserted = 0, duplicates = 0, failed = 0;
    const batch: Record<string, unknown>[] = [];

    for (const r of body) {
      const rec: Record<string, unknown> = {};
      const custom: Record<string, unknown> = {};
      header.forEach((target, i) => {
        if (!target) return;
        const v = (r[i] ?? "").trim();
        if (!v) return;
        if (customKeys.has(target)) custom[target] = v;
        else if (target === "budget_inr") rec[target] = Number(v.replace(/[^\d.]/g, "")) || null;
        else if (target === "email") rec[target] = v.toLowerCase();
        else rec[target] = v;
      });

      const email = (rec.email as string) ?? null;
      const phone = (rec.phone as string) ?? null;
      if (!rec.name && !email && !phone) { failed++; continue; }
      if ((email && seenEmail.has(email)) || (phone && seenPhone.has(phone))) { duplicates++; continue; }
      if (email) seenEmail.add(email);
      if (phone) seenPhone.add(phone);

      batch.push({
        ...rec,
        org_id: org.id,
        name: rec.name ?? email?.split("@")[0] ?? phone ?? "Unknown",
        source: "csv_import",
        stage_key: firstStage,
        custom,
        next_follow_up_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });
    }

    // ── 3. the precise pre-flight, now that we know what will actually be
    //       written ────────────────────────────────────────────────────────
    // `batch` excludes duplicates and rows with no contact details, so this is
    // the real number of inserts. Refusing HERE, before the first write,
    // replaces the old behaviour: 1,000 rows committed, 500 silently dropped,
    // and no record anywhere of which 500 they were.
    if (batch.length > remaining) {
      setBusy(false);
      setProgress(null);
      setBlocked({
        title: "This file is larger than the room left on your plan",
        detail: `${batch.length.toLocaleString("en-IN")} new ${batch.length === 1 ? "record" : "records"} would be imported (${duplicates.toLocaleString("en-IN")} already in your CRM${failed ? `, ${failed.toLocaleString("en-IN")} with no contact details` : ""}), and there is room for ${remaining.toLocaleString("en-IN")} more — ${used.toLocaleString("en-IN")} of ${cap?.toLocaleString("en-IN")} used. Nothing has been imported, because a partial import would leave you unable to tell which rows made it.`,
        upgrade: true,
      });
      return;
    }

    // A rejected batch used to be counted into `failed`, which is rendered as
    // "Rows with no contact" — so hitting the plan limit told the user their
    // CSV was malformed. They would go and edit a perfectly good file.
    // Rejections are now counted and explained separately; guard_lead_limit's
    // message is written to be shown to a person.
    let rejected = 0;
    let notAttempted = 0;
    let rejectReason: string | null = null;

    // chunked so a large file doesn't hit request limits.
    //
    // This loop used to CONTINUE past a failed chunk. Every realistic cause of
    // a chunk failing — the plan cap, a lost connection, an RLS refusal —
    // applies equally to the chunks after it, so carrying on meant firing seven
    // more doomed requests and then reporting a number that mixed rows written,
    // rows refused and rows refused for a second, different reason. It stops on
    // the first failure now and says precisely how far it got, so re-running
    // the same file after fixing the cause is a safe, dedupe-protected action.
    for (let i = 0; i < batch.length; i += 200) {
      const chunk = batch.slice(i, i + 200);
      setProgress({ done: i, total: batch.length, phase: `Importing ${ui.leadNounPlural.toLowerCase()}` });
      const { error, count } = await supabase
        .from("leads")
        .insert(chunk, { count: "exact" });
      if (error) {
        rejected = chunk.length;
        rejectReason = error.message;
        notAttempted = batch.length - i - chunk.length;
        break;
      }
      inserted += count ?? chunk.length;
    }
    setProgress({ done: batch.length, total: batch.length, phase: "Finishing up" });

    const { error: importLogErr } = await supabase.from("imports").insert({
      org_id: org.id, user_id: profile?.id ?? null, filename,
      kind: "csv", total: body.length, inserted, duplicates,
    });
    // Non-fatal: the records themselves are in. But the import history is the
    // only place that records this file ever ran, so a failure must not pass
    // in silence — without it a repeated import looks like a first one.
    if (importLogErr) {
      console.error("import history row not saved:", importLogErr.message);
      toast.error(`Records imported, but this import could not be added to your history: ${importLogErr.message}`);
    }

    setBusy(false);
    setProgress(null);
    setResult({ inserted, duplicates, failed, rejected, notAttempted, rejectReason });
  };

  // A bare <Spinner/> for the whole screen told someone importing 5,000 rows
  // nothing at all for the better part of a minute — indistinguishable from a
  // hang, and the obvious response is to reload, which abandons the import
  // mid-way. Rows done / total, and which phase it is in.
  if (busy) {
    const pct = progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0;
    return (
      <Card title="Importing…">
        <p className="sub" style={{ marginTop: -8 }}>
          {progress?.phase ?? "Working"} — {(progress?.done ?? 0).toLocaleString("en-IN")}
          {progress?.total ? ` of ${progress.total.toLocaleString("en-IN")}` : ""} rows.
        </p>
        <div style={{ height: 8, background: "var(--track)", borderRadius: 999, marginTop: 12, overflow: "hidden" }}>
          <div
            style={{
              width: `${pct}%`, height: "100%", background: "var(--grad)",
              borderRadius: 999, transition: "width var(--t) var(--ease)",
            }}
          />
        </div>
        <p className="sub" style={{ fontSize: 12, marginTop: 12 }}>
          Please keep this tab open. Closing it stops the import part-way through.
        </p>
      </Card>
    );
  }

  return (
    <div className="stack">
      <div>
        <h1>Import</h1>
        <p className="sub" style={{ marginTop: 2 }}>Bring {ui.leadNounPlural.toLowerCase()} in from a CSV file.</p>
      </div>

      {/* Refused before a single row was written. Deliberately not a toast:
          this needs to persist, explain the arithmetic, and offer the way out. */}
      {blocked && (
        <Card>
          <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
            <span style={{ fontSize: 22 }}>⛔</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>{blocked.title}</div>
              <p className="sub" style={{ marginTop: 4 }}>{blocked.detail}</p>
              <div className="row row-wrap" style={{ marginTop: 12 }}>
                {blocked.upgrade && (
                  <button className="btn btn-primary" onClick={() => navigate("/settings")}>
                    See plans &amp; upgrade →
                  </button>
                )}
                <button className="btn" onClick={() => setBlocked(null)}>Back to the mapping</button>
              </div>
              <p className="sub" style={{ fontSize: 12, marginTop: 10 }}>
                Settings → Plan &amp; Usage shows exactly how much room each plan gives you.
              </p>
            </div>
          </div>
        </Card>
      )}

      {result ? (
        <Card title={result.rejected > 0 ? "Import stopped part-way" : "Import complete"}>
          <div className="grid grid-kpi">
            <div className="kpi">
              <div className="kpi-label"><span>✅</span><span>Imported</span></div>
              <div className="kpi-value" style={{ color: "var(--green)" }}>{result.inserted}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><span>♻️</span><span>Duplicates skipped</span></div>
              <div className="kpi-value">{result.duplicates}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><span>⚠️</span><span>Rows with no contact</span></div>
              <div className="kpi-value" style={{ color: result.failed ? "var(--red)" : undefined }}>{result.failed}</div>
            </div>
            {result.rejected > 0 && (
              <div className="kpi">
                <div className="kpi-label"><span>⛔</span><span>Refused</span></div>
                <div className="kpi-value" style={{ color: "var(--red)" }}>{result.rejected}</div>
              </div>
            )}
            {result.notAttempted > 0 && (
              <div className="kpi">
                <div className="kpi-label"><span>⏸</span><span>Not attempted</span></div>
                <div className="kpi-value" style={{ color: "var(--amber)" }}>{result.notAttempted}</div>
              </div>
            )}
          </div>

          {result.rejected > 0 && (
            <div
              className="card"
              style={{ marginTop: 14, background: "var(--bg)", borderColor: "var(--red)" }}
            >
              <div style={{ fontWeight: 700 }}>
                Stopped after {result.inserted.toLocaleString("en-IN")}{" "}
                {result.inserted === 1 ? "record" : "records"} were written
              </div>
              {/* Exact, not approximate. Somebody has to be able to reconcile
                  this against their file, and "some rows failed" cannot be. */}
              <p className="sub" style={{ marginTop: 4 }}>
                A batch of {result.rejected} {result.rejected === 1 ? "row was" : "rows were"} refused
                by the server, so the import stopped there rather than firing the rest at the same
                wall. That left {result.notAttempted.toLocaleString("en-IN")}{" "}
                {result.notAttempted === 1 ? "row" : "rows"} never sent.
                {result.rejectReason ? ` The server said: “${result.rejectReason}”` : ""}
              </p>
              <p className="sub" style={{ marginTop: 8 }}>
                This is not a problem with your file — those rows had contact details. Fix the cause
                and import <b>the same file</b> again: the{" "}
                {result.inserted.toLocaleString("en-IN")} already written will be skipped as
                duplicates, so nothing doubles up.
              </p>
            </div>
          )}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => navigate("/leads")}>View {ui.leadNounPlural} →</button>
            <button className="btn" onClick={() => { setRows([]); setResult(null); setFilename(""); setBlocked(null); }}>Import another</button>
          </div>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <div
            style={{
              border: "2px dashed var(--border)", borderRadius: 14, padding: 42,
              textAlign: "center", cursor: "pointer",
            }}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void onFile(f); }}
          >
            <div style={{ fontSize: 38 }}>📄</div>
            <div style={{ fontWeight: 700, marginTop: 9 }}>Drop a CSV here, or click to choose</div>
            <p className="sub" style={{ marginTop: 5 }}>
              First row should be column headers. We'll match them up automatically.
            </p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
          />
        </Card>
      ) : (
        <Card title={`Map columns — ${filename}`} action={<span className="pill">{rows.length - 1} rows</span>}>
          <p className="sub" style={{ marginTop: -8, marginBottom: 14 }}>
            Check the guesses below. Anything set to "skip" is ignored. Records already in your CRM
            (matched on email or phone) are skipped rather than duplicated.
          </p>

          <div className="table-wrap" style={{ marginBottom: 15 }}>
            <table className="data">
              <thead>
                <tr><th>CSV column</th><th>First value</th><th>Import as</th></tr>
              </thead>
              <tbody>
                {rows[0].map((h, i) => (
                  <tr key={i} style={{ cursor: "default" }}>
                    <td style={{ fontWeight: 600 }}>{h || <span className="sub">(blank)</span>}</td>
                    <td className="sub">{rows[1]?.[i] || "—"}</td>
                    <td>
                      <select
                        className="select"
                        style={{ maxWidth: 210 }}
                        value={mapping[i] ?? ""}
                        onChange={(e) => setMapping(mapping.map((m, j) => (j === i ? e.target.value : m)))}
                      >
                        {TARGETS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                        {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => { setRows([]); setFilename(""); setBlocked(null); }}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={run}
              disabled={!mapping.some((m) => m === "name" || m === "email" || m === "phone")}
            >
              Import {rows.length - 1} rows
            </button>
          </div>
          {!mapping.some((m) => m === "name" || m === "email" || m === "phone") && (
            <p className="sub" style={{ textAlign: "right", marginTop: 7, color: "var(--red)" }}>
              Map at least one of name, email or phone.
            </p>
          )}
        </Card>
      )}
      {toast.node}
    </div>
  );
}
