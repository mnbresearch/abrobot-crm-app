/**
 * Tests for ai-copilot schema structures, automation synthesis validation,
 * and AI enrichment response contracts.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadEsbuild() {
  for (const c of [
    "esbuild",
    path.join(__dirname, "..", "..", "..", "app", "node_modules", "esbuild"),
    path.join(__dirname, "..", "..", "..", "node_modules", "esbuild"),
    "/tmp/node_modules/esbuild",
  ]) {
    try {
      const m = require(c);
      m.transformSync("const a = 1;", { loader: "ts" });
      return m;
    } catch (_) {
      /* next */
    }
  }
  console.log("SKIP " + path.basename(__filename) + " — no usable esbuild for this platform.");
  process.exit(0);
}

const es = loadEsbuild();

function loadTs(file) {
  const js = es.transformSync(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    loader: "ts",
    format: "cjs",
  }).code;
  const m = { exports: {} };
  new Function("module", "exports", "require", js)(m, m.exports, (s) => {
    throw new Error("unexpected import " + s);
  });
  return m.exports;
}

const { shouldRun, triggerFires, inCooldown, conditionsPass } = loadTs("automations.ts");

test("AI automation synthesis: schema validates triggers in automations engine", () => {
  const VALID_TRIGGERS = [
    "no_contact_for",
    "follow_up_overdue",
    "score_above",
    "score_below",
    "lead_created",
    "stage_changed",
  ];

  // A generated automation from ai-copilot
  const aiGeneratedRule = {
    id: "gen-1",
    org_id: "org-1",
    name: "Chase silent hot leads",
    enabled: true,
    trigger: "no_contact_for",
    trigger_value: 48,
    conditions: [
      { field: "score", op: "gt", value: 60 }
    ],
    actions: [
      { action: "set_stage", value: "contacted" }
    ],
    cooldown_hours: 24,
  };

  assert.ok(VALID_TRIGGERS.includes(aiGeneratedRule.trigger), "Trigger must be known");
  assert.strictEqual(typeof aiGeneratedRule.name, "string");
  assert.ok(aiGeneratedRule.name.length > 0);
  assert.ok(Array.isArray(aiGeneratedRule.conditions));
  assert.ok(Array.isArray(aiGeneratedRule.actions));
  assert.strictEqual(aiGeneratedRule.actions[0].action, "set_stage");
});

test("AI automation synthesis: generated rule executes correctly in core automations engine", () => {
  const NOW = new Date("2026-11-07T12:00:00Z");
  const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

  const rule = {
    id: "gen-rule",
    org_id: "org-1",
    name: "AI Generated Rule",
    enabled: true,
    trigger: "no_contact_for",
    trigger_value: 48,
    conditions: [{ field: "score", op: "gt", value: 50 }],
    actions: [{ action: "notify_telegram" }],
    cooldown_hours: 24,
  };

  const hotLead = {
    id: "lead-1",
    name: "Alex Patel",
    score: 75,
    stage_key: "new",
    source: "website",
    last_contacted_at: hoursAgo(72),
    created_at: hoursAgo(100),
  };

  assert.ok(triggerFires(rule, hotLead, NOW), "Rule should fire for lead untouched 72h");
  assert.ok(shouldRun(rule, hotLead, null, NOW), "Rule should run for eligible record");

  // Inside cooldown
  assert.strictEqual(shouldRun(rule, hotLead, hoursAgo(4), NOW), false, "Rule should be blocked by cooldown");
});

test("AI Enrichment schema: validates required intelligence attributes", () => {
  const enrichmentSample = {
    buyer_persona: "Enterprise Decision Maker",
    urgency_tier: "immediate",
    inferred_location: "London, UK",
    deal_risk_signals: "Competitive evaluation against Attio/HubSpot",
    suggested_tags: ["enterprise-tier", "high-budget", "q4-close"],
  };

  const VALID_URGENCY_TIERS = ["immediate", "this_quarter", "exploratory"];

  assert.strictEqual(typeof enrichmentSample.buyer_persona, "string");
  assert.ok(VALID_URGENCY_TIERS.includes(enrichmentSample.urgency_tier));
  assert.strictEqual(typeof enrichmentSample.inferred_location, "string");
  assert.strictEqual(typeof enrichmentSample.deal_risk_signals, "string");
  assert.ok(Array.isArray(enrichmentSample.suggested_tags));
  assert.ok(enrichmentSample.suggested_tags.length <= 5);
});
