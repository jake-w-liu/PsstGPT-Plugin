import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { __testing, createPsstGPTAuditBundle, createPsstGPTUploadBundle } from "./psst_gpt.mjs";

test("extractAssistantTextFromAppState reads text after the matching prompt", () => {
  const prompt = "Reply exactly: OK PsstGPT smoke 2026-06-26";
  const state = {
    transcriptTexts: [
      "Older answer",
      prompt,
      "Thought for 2s",
      "OK PsstGPT smoke 2026-06-26",
      "Ask anything",
    ],
  };

  assert.equal(
    __testing.extractAssistantTextFromAppState(state, prompt),
    "OK PsstGPT smoke 2026-06-26"
  );
});

test("extractAssistantTextFromAppState uses the latest matching prompt", () => {
  const prompt = "Summarize this";
  const state = {
    transcriptTexts: [
      prompt,
      "First answer",
      prompt,
      "Second answer",
    ],
  };

  assert.equal(
    __testing.extractAssistantTextFromAppState(state, prompt),
    "Second answer"
  );
});

test("transcriptContainsPrompt handles long prompt excerpts", () => {
  const prompt = "A".repeat(120);
  const state = {
    transcriptTexts: [`${"A".repeat(90)} clipped by accessibility`],
  };

  assert.equal(__testing.transcriptContainsPrompt(state, prompt), true);
});

test("transcriptContainsPrompt handles transcript-side long excerpts", () => {
  const prompt = `${"FINAL AUDIT REQUEST ".repeat(12)}with additional hidden bundle text`;
  const visibleExcerpt = prompt.slice(0, 100);
  const state = {
    transcriptTexts: [visibleExcerpt],
  };

  assert.equal(__testing.transcriptContainsPrompt(state, prompt), true);
});

test("completion requires stable non-transient assistant text", () => {
  assert.equal(
    __testing.isAppResponseCompleteSnapshot({
      assistantText: "Thinking",
      textStableForMs: 60000,
      isAnswering: false,
    }),
    false
  );

  assert.equal(
    __testing.isAppResponseCompleteSnapshot({
      assistantText: "Final answer",
      textStableForMs: 1000,
      isAnswering: false,
    }),
    false
  );

  assert.equal(
    __testing.isAppResponseCompleteSnapshot({
      assistantText: "Final answer",
      textStableForMs: 8000,
      isAnswering: false,
    }),
    true
  );
});

test("unsupported PsstGPT options fail explicitly", () => {
  assert.throws(
    () => __testing.assertSupportedAppRelayOptions({
      prompt: "Analyze this file",
      attachments: [{ path: "/tmp/file.txt" }],
    }),
    /Unsupported option\(s\): attachments/
  );

  assert.throws(
    () => __testing.assertSupportedAppRelayOptions({
      prompt: "Use 5.5 Pro",
      model: "5.5",
      mode: "pro",
    }),
    /model\/mode\/effort selection/
  );

  assert.throws(
    () => __testing.assertSupportedAppRelayOptions({
      prompt: "Foreground this",
      background: false,
    }),
    /foreground mode/
  );

  assert.throws(
    () => __testing.assertSupportedAppRelayOptions({
      prompt: "Recover the window",
      allowWindowRecovery: true,
    }),
    /window recovery/
  );
});

test("task planner routes full codebase audits to upload", () => {
  const plan = __testing.resolvePsstGPTTaskPlan({
    prompt: "debug audit the full codebase",
  });

  assert.equal(plan.action, "upload-audit");
  assert.equal(plan.transport, "foreground-upload");
  assert.equal(plan.requiresForeground, true);
});

test("task planner keeps explicit strict-background audits on text bundle", () => {
  const plan = __testing.resolvePsstGPTTaskPlan({
    prompt: "strict background debug audit the full codebase with no popups",
  });

  assert.equal(plan.action, "audit");
  assert.equal(plan.transport, "strict-background-text-bundle");
  assert.equal(plan.requiresForeground, false);
});

test("task planner routes plain prompts to text relay", () => {
  const plan = __testing.resolvePsstGPTTaskPlan({
    prompt: "Write a short note about release risk.",
  });

  assert.equal(plan.action, "run");
  assert.equal(plan.transport, "strict-background-text");
});

test("task prompt wrappers preserve exact-output requests", () => {
  const uploadPrompt = __testing.buildUploadTaskPrompt("reply exactly: MARKER");
  const textPrompt = __testing.buildTextAuditTaskPrompt("reply exactly: MARKER");

  assert.match(uploadPrompt, /If the user asks for an exact output string or format/);
  assert.match(uploadPrompt, /User request: reply exactly: MARKER/);
  assert.match(textPrompt, /If the user asks for an exact output string or format/);
  assert.match(textPrompt, /User request: reply exactly: MARKER/);
});

test("final delivery includes app session id", () => {
  assert.equal(
    __testing.formatAppFinalDeliveryText({
      assistantText: "Visible app answer",
      relaySessionId: "app-123",
    }),
    "Visible app answer\n\nPsstGPT session: app-123"
  );
});

test("messagesForAppRelay appends assistant text once", () => {
  const messages = __testing.messagesForAppRelay(
    "Prompt",
    "Answer",
    [{ index: 0, role: "user", text: "Prompt" }]
  );

  assert.deepEqual(messages, [
    { index: 0, role: "user", text: "Prompt" },
    { index: 1, role: "assistant", text: "Answer" },
  ]);

  const unchanged = __testing.messagesForAppRelay("Prompt", "Answer", messages);
  assert.deepEqual(unchanged, messages);
});

test("messagesForAppRelay preserves history and replaces trailing assistant updates", () => {
  const history = [
    { index: 0, role: "user", text: "First prompt" },
    { index: 1, role: "assistant", text: "First answer" },
  ];

  const pending = __testing.messagesForAppRelay("Second prompt", "Partial answer", history);
  assert.deepEqual(pending, [
    { index: 0, role: "user", text: "First prompt" },
    { index: 1, role: "assistant", text: "First answer" },
    { index: 2, role: "user", text: "Second prompt" },
    { index: 3, role: "assistant", text: "Partial answer" },
  ]);

  const complete = __testing.messagesForAppRelay("Second prompt", "Final answer", pending);
  assert.deepEqual(complete, [
    { index: 0, role: "user", text: "First prompt" },
    { index: 1, role: "assistant", text: "First answer" },
    { index: 2, role: "user", text: "Second prompt" },
    { index: 3, role: "assistant", text: "Final answer" },
  ]);
});

test("storedCompleteAppRelayResult recovers only complete stored assistant text", () => {
  const completeSession = {
    relaySessionId: "app-1",
    status: "complete",
    mode: "Current ChatGPT app selection",
    background: true,
    messages: [
      { role: "user", text: "Prompt" },
      { role: "assistant", text: "Final answer" },
    ],
  };
  const result = __testing.storedCompleteAppRelayResult(completeSession, {
    title: "ChatGPT",
    visibleModelLabel: "5.1",
  });

  assert.equal(result.status, "complete");
  assert.equal(result.assistantText, "Final answer");
  assert.equal(result.finalDeliveryText, "Final answer\n\nPsstGPT session: app-1");

  assert.equal(
    __testing.storedCompleteAppRelayResult({ ...completeSession, status: "pending" }),
    null
  );
  assert.equal(
    __testing.storedCompleteAppRelayResult({
      ...completeSession,
      messages: [{ role: "user", text: "Prompt" }],
    }),
    null
  );
});

test("audit acknowledgement detector catches non-substantive final replies only", () => {
  assert.equal(
    __testing.isLikelyAcknowledgementOnlyAuditResponse(
      "I will audit only the provided bundle chunks and report concrete, line-cited findings grounded in the displayed source."
    ),
    true
  );
  assert.equal(__testing.isLikelyAcknowledgementOnlyAuditResponse("READY"), true);
  assert.equal(__testing.isLikelyAcknowledgementOnlyAuditResponse("ACK 2"), true);
  assert.equal(
    __testing.isLikelyAcknowledgementOnlyAuditResponse(
      "No confirmed correctness bugs were found. Residual risks: missing integration tests for the upload path."
    ),
    false
  );
  assert.equal(
    __testing.isLikelyAcknowledgementOnlyAuditResponse(
      "Findings\n\n1. src/main.mjs:42 can throw on empty input because the null check runs after property access."
    ),
    false
  );
});

test("audit retry prompt is skipped for exact-output requests", () => {
  assert.equal(__testing.isExactOutputRequest("User request: reply exactly: MARKER"), true);
  assert.equal(__testing.isExactOutputRequest("reply exactly OK"), true);
  assert.equal(
    __testing.isExactOutputRequest(
      "If the user asks for an exact output string, follow it.\n\nUser request: debug audit the codebase"
    ),
    false
  );

  const prompt = __testing.buildAuditRetryPrompt({
    bundleId: "bundle-123",
    requestedPrompt: "debug audit the codebase",
    attempt: 1,
  });
  assert.match(prompt, /Do the audit now/);
  assert.match(prompt, /bundle-123/);
  assert.match(prompt, /Do not acknowledge/);
});

test("parseDirectAxHelperJson accepts pretty helper payloads", () => {
  const payload = {
    ok: false,
    code: "PSST_GPT_DIRECT_AX_FAILED",
    message: "Missing JSON input argument",
  };
  const pretty = JSON.stringify(payload, null, 2);

  assert.deepEqual(__testing.parseDirectAxHelperJson(pretty), payload);
  assert.deepEqual(__testing.parseDirectAxHelperJson(`warning: ignored\n${pretty}`), payload);
  assert.equal(__testing.parseDirectAxHelperJson("not json"), null);
});

test("parseDirectAxHelperJson keeps the full nested payload when warnings precede JSON", () => {
  const payload = {
    ok: true,
    status: "complete",
    assistantText: "MARKER",
    state: {
      title: "ChatGPT",
      nested: { value: 1 },
    },
  };
  const pretty = JSON.stringify(payload, null, 2);

  assert.deepEqual(
    __testing.parseDirectAxHelperJson(`warning: ignored\n${pretty}`),
    payload
  );
});

test("calculateDirectAxRelayTimeoutMs budgets upload time per file", () => {
  assert.equal(
    __testing.calculateDirectAxRelayTimeoutMs({
      timeoutMs: 300000,
      uploadTimeoutMs: 2000,
      fileCount: 3,
    }),
    336000
  );
});

test("mergeSessionBackground keeps foreground workflows marked foreground-used", () => {
  assert.equal(__testing.mergeSessionBackground(undefined, undefined), true);
  assert.equal(__testing.mergeSessionBackground(true, true), true);
  assert.equal(__testing.mergeSessionBackground(false, true), false);
  assert.equal(__testing.mergeSessionBackground(true, false), false);
});

test("send button detection handles long scrollable composer geometry", () => {
  const longComposer = {
    position: { x: 772, y: 345 },
    size: { width: 666, height: 10200 },
  };
  const sendButton = {
    description: "button",
    position: { x: 1421, y: 555 },
    size: { width: 32, height: 37 },
  };
  const shareButton = {
    description: "Share",
    position: { x: 1367, y: 109 },
    size: { width: 50, height: 52 },
  };
  const leftComposerButton = {
    description: "button",
    position: { x: 901, y: 562 },
    size: { width: 53, height: 24 },
  };

  assert.equal(__testing.visibleComposerBottomY(longComposer), 705);
  assert.equal(__testing.isPossibleSendButtonRecord(sendButton, longComposer), true);
  assert.equal(__testing.isPossibleSendButtonRecord(shareButton, longComposer), false);
  assert.equal(__testing.isPossibleSendButtonRecord(leftComposerButton, longComposer), false);
});

test("send button detection still handles normal empty composer geometry", () => {
  const emptyComposer = {
    position: { x: 772, y: 528 },
    size: { width: 666, height: 17 },
  };
  const sendButton = {
    description: "button",
    position: { x: 1421, y: 555 },
    size: { width: 32, height: 37 },
  };

  assert.equal(__testing.visibleComposerBottomY(emptyComposer), 545);
  assert.equal(__testing.isPossibleSendButtonRecord(sendButton, emptyComposer), true);
});

test("chunkTextByLines preserves text content across chunks", () => {
  const text = ["alpha", "beta", "gamma", "delta"].join("\n");
  const chunks = __testing.chunkTextByLines(text, 12);

  assert.deepEqual(chunks, ["alpha\nbeta", "gamma\ndelta"]);
  assert.equal(chunks.join("\n"), text);
});

test("createPsstGPTAuditBundle writes line-numbered markdown and skips excluded files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "psst-gpt-audit-test-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Demo\n", "utf8");
    await writeFile(path.join(root, "main.mjs"), "console.log('marker');\n", "utf8");
    await writeFile(path.join(root, "image.png"), "not really an image\n", "utf8");

    const bundle = await createPsstGPTAuditBundle({
      root,
      maxFileBytes: 1024,
      maxTotalBytes: 4096,
    });
    const markdown = await readFile(bundle.markdownPath, "utf8");

    assert.equal(bundle.root, root);
    assert.deepEqual(bundle.files.map((file) => file.path).sort(), ["README.md", "main.mjs"].sort());
    assert.match(markdown, /### README\.md/);
    assert.match(markdown, /    1: # Demo/);
    assert.match(markdown, /### main\.mjs/);
    assert.match(markdown, /    1: console\.log\('marker'\);/);
    assert.equal(bundle.skipped.some((entry) => entry.path === "image.png"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createPsstGPTUploadBundle writes zip shards and a manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "psst-gpt-upload-test-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "src", "a.js"), `${"a".repeat(900)}\n`, "utf8");
    await writeFile(path.join(root, "src", "b.js"), `${"b".repeat(900)}\n`, "utf8");
    await writeFile(path.join(root, "README.md"), "# Demo\n", "utf8");
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "ignored\n", "utf8");

    const bundle = await createPsstGPTUploadBundle({
      root,
      shardBytes: 1024,
      maxSingleFileBytes: 1024,
    });
    const manifest = JSON.parse(await readFile(bundle.manifestPath, "utf8"));

    assert.equal(bundle.root, root);
    assert.equal(manifest.includedFileCount, 3);
    assert.equal(bundle.files.some((file) => file.path === "src/a.js"), true);
    assert.equal(bundle.files.some((file) => file.path === "src/b.js"), true);
    assert.equal(bundle.files.some((file) => file.path === "README.md"), true);
    assert.equal(bundle.skipped.some((entry) => entry.path === "node_modules"), true);
    assert.equal(bundle.shards.length >= 2, true);
    for (const shard of bundle.shards) {
      const shardStat = await stat(shard.path);
      assert.equal(shardStat.isFile(), true);
      assert.equal(shardStat.size > 0, true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
