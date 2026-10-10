# LLM fixtures (`tests/fixtures/llm/`)

The mock adapter (`engine/llm/mock.js`) answers every model call from a file in this folder when
`MOCK_LLM=1`. It is selected **only** by that variable — never as a budget fallback (review M5.4):
when the month's budget is spent the router throws `BudgetExhaustedError` and the agent is skipped.
A missing fixture throws `MockFixtureError`; the mock never fabricates output.

## File name

`<agent>.<case>.json` — `agent` is a roster name (`ceo`, `hr`, `strategist`, `writer`, `qa`,
`analyst`), `case` is chosen per call:

1. `MOCK_LLM_CASE_<AGENT>` (upper-case agent name, e.g. `MOCK_LLM_CASE_WRITER=bad`), else
2. `MOCK_LLM_CASE`, else
3. `ok`.

Page-keyed variant: when the call carries a page handle (the router passes `context.page`, or the
brand's handle) and `<agent>.<case>.<page>.json` exists, that file wins over `<agent>.<case>.json`
(e.g. `qa.ok.kaatdo.json`, `qa.ok.job_rez.json`; `qa.ok.json` serves RishtaPatra and any page
without its own file). QA claims cite brand-specific fact ids, so one `MOCK_LLM=1` run can answer
every page.

## Shape

```json
{
  "agent": "writer",
  "case": "ok",
  "output": { "...": "exactly what the model would return, validated with assertShape(OUTPUT_SPEC)" },
  "usage": { "inputTokens": 5800, "outputTokens": 900 }
}
```

- `output` (required, object) becomes the adapter's `json`; its `JSON.stringify` is the `text`.
- `usage` token counts are copied into the usage line; `costUsd` is always `0`, `provider` is `mock`,
  `model` is `mock`, `mock` is `true`.
- `agent`, `case` and the optional `page` are documentation for the reader; the file name is what
  selects the fixture.

Agent fixtures land with their agents: `qa.ok.json` (RishtaPatra claims), `qa.ok.kaatdo.json`,
`qa.ok.job_rez.json` and `qa.fail.json` (one claim without a fact id) in FEAT-104; `strategist.*`,
`writer.*`, `ceo.*`, `hr.ok.json` in FEAT-105 (every `*.ok.json` output must pass the agent's
`OUTPUT_SPEC`, review M7 prove-by in `tests/schema-dialects.test.js`). A `*.bad.json` fixture that
fails validation exercises the router's single repair call: the mock returns the same fixture again,
so the call ends in `AgentOutputError` after exactly two attempts.
