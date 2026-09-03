import { useRef, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, Spinner, useToast } from "../components/ui";

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

export function Import({ navigate }: { navigate: (to: string) => void }) {
  const { org, ui, profile, stages, fields } = useApp();
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<string[]>([]);
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    inserted: number;
    duplicates: number;
    failed: number;               // rows we skipped: no email and no phone
    rejected: number;             // rows the database refused — a different thing
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

    const header = mapping;
    const body = rows.slice(1);
    const firstStage = stages[0]?.key ?? "new";

    // Pull existing contacts once — cheaper and more reliable than a query
    // per row, and it lets us report duplicates honestly.
    const { data: existing } = await supabase.from("leads").select("email, phone").eq("org_id", org.id);
    const seenEmail = new Set((existing ?? []).map((e) => (e.email ?? "").toLowerCase()).filter(Boolean));
    const seenPhone = new Set((existing ?? []).map((e) => e.phone ?? "").filter(Boolean));

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

    // A rejected batch used to be counted into `failed`, which is rendered as
    // "Rows with no contact" — so hitting the plan limit told the user their
    // CSV was malformed. They would go and edit a perfectly good file.
    // Rejections are now counted and explained separately; guard_lead_limit's
    // message is written to be shown to a person.
    let rejected = 0;
    let rejectReason: string | null = null;

    // chunked so a large file doesn't hit request limits
    for (let i = 0; i < batch.length; i += 200) {
      const chunk = batch.slice(i, i + 200);
      const { error, count } = await supabase
        .from("leads")
        .insert(chunk, { count: "exact" });
      if (error) {
        rejected += chunk.length;
        rejectReason ??= error.message;
      } else {
        inserted += count ?? chunk.length;
      }
    }

    const { error: importLogErr } = await supabase.from("imports").insert({
      org_id: org.id, user_id: profile?.id ?? null, filename,
      kind: "csv", total: body.length, inserted, duplicates,
    });
    if (importLogErr) console.error("import history row not saved:", importLogErr.message);

    setBusy(false);
    setResult({ inserted, duplicates, failed, rejected, rejectReason });
  };

  if (busy) return <Spinner />;

  return (
    <div className="stack">
      <div>
        <h1>Import</h1>
        <p className="sub" style={{ marginTop: 2 }}>Bring {ui.leadNounPlural.toLowerCase()} in from a CSV file.</p>
      </div>

      {result ? (
        <Card title="Import complete">
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
                <div className="kpi-label"><span>⛔</span><span>Rejected</span></div>
                <div className="kpi-value" style={{ color: "var(--red)" }}>{result.rejected}</div>
              </div>
            )}
          </div>

          {result.rejected > 0 && (
            <div
              className="card"
              style={{ marginTop: 14, background: "var(--bg)", borderColor: "var(--red)" }}
            >
              <div style={{ fontWeight: 700 }}>
                {result.rejected} {result.rejected === 1 ? "row was" : "rows were"} refused by the server
              </div>
              <p className="sub" style={{ marginTop: 4 }}>
                This is not a problem with your file — those rows had contact details.
                {result.rejectReason ? ` The server said: “${result.rejectReason}”` : ""}
              </p>
            </div>
          )}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => navigate("/leads")}>View {ui.leadNounPlural} →</button>
            <button className="btn" onClick={() => { setRows([]); setResult(null); setFilename(""); }}>Import another</button>
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
            <button className="btn" onClick={() => { setRows([]); setFilename(""); }}>Cancel</button>
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
