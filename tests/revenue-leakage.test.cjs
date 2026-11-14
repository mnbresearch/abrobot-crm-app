const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadEsbuild() {
  const candidates = [
    "esbuild",
    path.join(__dirname, "..", "app", "node_modules", "esbuild"),
    path.join(__dirname, "..", "node_modules", "esbuild"),
    "/tmp/node_modules/esbuild",
  ];
  for (const c of candidates) {
    try {
      const mod = require(c);
      mod.transformSync("const a = 1;", { loader: "ts" });
      return mod;
    } catch (_) { /* try next */ }
  }
  console.log("SKIP " + path.basename(__filename) + " — no usable esbuild");
  process.exit(0);
}

const es = loadEsbuild();
const srcPath = path.join(__dirname, "..", "app", "src", "lib", "revenueLeakage.ts");
const src = fs.readFileSync(srcPath, "utf8");
const js = es.transformSync(src, { loader: "ts", format: "cjs" }).code;

// Evaluate module in isolated context
const mod = { exports: {} };
const fn = new Function("module", "exports", "require", js);
fn(mod, mod.exports, require);
const {
  estimateLeadValue,
  formatCurrencyINR,
  analyzeRevenueLeakage,
} = mod.exports;

test("estimateLeadValue: uses explicit budget_inr if present", () => {
  const lead = { score: 20, budget_inr: 450000 };
  assert.strictEqual(estimateLeadValue(lead), 450000);
});

test("estimateLeadValue: falls back to score tiers or default when budget is missing", () => {
  assert.strictEqual(estimateLeadValue({ score: 85, budget_inr: null }), 300000);
  assert.strictEqual(estimateLeadValue({ score: 60, budget_inr: 0 }), 200000);
  assert.strictEqual(estimateLeadValue({ score: 30 }), 150000);
});

test("formatCurrencyINR: formats numbers with Indian currency notation", () => {
  assert.strictEqual(formatCurrencyINR(0), "₹0");
  assert.strictEqual(formatCurrencyINR(250000, false), "₹2,50,000");
  assert.strictEqual(formatCurrencyINR(150000, true), "₹1.5 L");
  assert.strictEqual(formatCurrencyINR(12500000, true), "₹1.25 Cr");
  assert.strictEqual(formatCurrencyINR(50000, true), "₹50k");
});

test("analyzeRevenueLeakage: excludes won and lost stages from pipeline", () => {
  const stages = [
    { key: "new", label: "New", is_won: false, is_lost: false },
    { key: "enrolled", label: "Enrolled", is_won: true, is_lost: false },
    { key: "dropped", label: "Dropped", is_won: false, is_lost: true },
  ];
  const leads = [
    { id: "1", stage_key: "new", score: 80, budget_inr: 200000, created_at: new Date().toISOString() },
    { id: "2", stage_key: "enrolled", score: 95, budget_inr: 500000, created_at: new Date().toISOString() },
    { id: "3", stage_key: "dropped", score: 10, budget_inr: 300000, created_at: new Date().toISOString() },
  ];
  const report = analyzeRevenueLeakage(leads, stages);
  assert.strictEqual(report.totalPipelineValue, 200000);
  // Won value is added to committed forecast
  assert.ok(report.forecast.committedValue >= 500000);
});

test("analyzeRevenueLeakage: detects SLA silence breach (>48h untouched)", () => {
  const now = 1700000000000;
  const stages = [{ key: "lead", label: "Lead", is_won: false, is_lost: false }];
  const leads = [
    {
      id: "l1",
      name: "Silent High-Value",
      stage_key: "lead",
      score: 80,
      budget_inr: 500000,
      created_at: new Date(now - 72 * 3600 * 1000).toISOString(),
      last_contacted_at: new Date(now - 72 * 3600 * 1000).toISOString(),
      assigned_to: "rep1",
    },
  ];
  const members = [{ id: "rep1", full_name: "Aman Rep", email: "aman@crm.com" }];
  const report = analyzeRevenueLeakage(leads, stages, members, 1000000, now);

  assert.strictEqual(report.atRiskDeals.length, 1);
  assert.strictEqual(report.atRiskDeals[0].riskType, "sla_breach");
  assert.strictEqual(report.atRiskDeals[0].assignedMemberName, "Aman Rep");
  assert.strictEqual(report.totalAtRiskValue, 500000);
  assert.strictEqual(report.riskTypeBreakdown.sla_breach.count, 1);
});

test("analyzeRevenueLeakage: detects overdue follow-ups (>24h late)", () => {
  const now = 1700000000000;
  const stages = [{ key: "demo", label: "Demo", is_won: false, is_lost: false }];
  const leads = [
    {
      id: "l2",
      name: "Missed Call Promise",
      stage_key: "demo",
      score: 30,
      budget_inr: 150000,
      created_at: new Date(now - 48 * 3600 * 1000).toISOString(),
      last_contacted_at: new Date(now - 30 * 3600 * 1000).toISOString(),
      next_follow_up_at: new Date(now - 36 * 3600 * 1000).toISOString(), // 36h overdue
      assigned_to: "rep2",
    },
  ];
  const report = analyzeRevenueLeakage(leads, stages, [], 1000000, now);
  assert.strictEqual(report.atRiskDeals.length, 1);
  assert.strictEqual(report.atRiskDeals[0].riskType, "overdue_followup");
});

test("analyzeRevenueLeakage: detects unassigned high-value revenue", () => {
  const now = 1700000000000;
  const stages = [{ key: "new", label: "New", is_won: false, is_lost: false }];
  const leads = [
    {
      id: "l3",
      name: "VIP Orphan Lead",
      stage_key: "new",
      score: 90,
      budget_inr: 750000,
      created_at: new Date(now - 2 * 3600 * 1000).toISOString(),
      last_contacted_at: new Date(now - 2 * 3600 * 1000).toISOString(),
      assigned_to: null,
    },
  ];
  const report = analyzeRevenueLeakage(leads, stages, [], 1000000, now);
  assert.strictEqual(report.atRiskDeals.length, 1);
  assert.strictEqual(report.atRiskDeals[0].riskType, "unassigned_revenue");
  assert.strictEqual(report.atRiskDeals[0].severity, "critical");
});

test("analyzeRevenueLeakage: health status reflects leakage threshold accurately", () => {
  const stages = [{ key: "active", label: "Active", is_won: false, is_lost: false }];
  const now = 1700000000000;
  // Case: critical leakage (>35%)
  const highRiskLeads = [
    {
      id: "l4",
      stage_key: "active",
      score: 80,
      budget_inr: 600000,
      created_at: new Date(now - 100 * 3600 * 1000).toISOString(),
      last_contacted_at: new Date(now - 100 * 3600 * 1000).toISOString(),
    },
    {
      id: "l5",
      stage_key: "active",
      score: 30,
      budget_inr: 200000,
      assigned_to: "rep1",
      created_at: new Date(now - 1 * 3600 * 1000).toISOString(),
      last_contacted_at: new Date(now - 1 * 3600 * 1000).toISOString(),
    },
  ];
  const report = analyzeRevenueLeakage(highRiskLeads, stages, [], 1000000, now);
  assert.strictEqual(report.leakageRatePct, 75);
  assert.strictEqual(report.healthStatus, "critical");
});
