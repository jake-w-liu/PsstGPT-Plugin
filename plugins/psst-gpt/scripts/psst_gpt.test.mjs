import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  __testing,
  auditPsstGPT,
  createPsstGPTAuditBundle,
  createPsstGPTUploadBundle,
  uploadAuditPsstGPT,
} from "./psst_gpt.mjs";

const execFileAsync = promisify(execFile);

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

test("response acceptance detection uses either visible prompt or a cleared composer", () => {
  const prompt = "Audit this upload";

  assert.equal(
    __testing.responseAcceptedFromAppState(
      { composerValue: prompt },
      prompt,
      { ...__testing.createAssistantCaptureState(), promptVisibleEver: false, incomplete: false }
    ),
    false
  );

  assert.equal(
    __testing.responseAcceptedFromAppState(
      { composerValue: "" },
      prompt,
      { ...__testing.createAssistantCaptureState(), promptVisibleEver: false, incomplete: false }
    ),
    true
  );

  assert.equal(
    __testing.responseAcceptedFromAppState(
      { composerValue: prompt },
      prompt,
      { ...__testing.createAssistantCaptureState(), promptVisibleEver: true, incomplete: false }
    ),
    true
  );
});

test("response start guard fails only when ChatGPT accepted the prompt but never started", () => {
  const prompt = "Audit this upload";
  const idleCapture = { ...__testing.createAssistantCaptureState(), promptVisibleEver: false, incomplete: false };
  const acceptedCapture = { ...__testing.createAssistantCaptureState(), promptVisibleEver: true, incomplete: false };

  assert.equal(
    __testing.shouldFailResponseStart({
      responseStartedEver: false,
      state: { composerValue: prompt, isAnswering: false },
      prompt,
      captureState: idleCapture,
      stableForMs: 120000,
      responseStartTimeoutMs: 90000,
    }),
    false
  );

  assert.equal(
    __testing.shouldFailResponseStart({
      responseStartedEver: false,
      state: { composerValue: "", isAnswering: false },
      prompt,
      captureState: acceptedCapture,
      stableForMs: 120000,
      responseStartTimeoutMs: 90000,
    }),
    true
  );

  assert.equal(
    __testing.shouldFailResponseStart({
      responseStartedEver: true,
      state: { composerValue: "", isAnswering: true },
      prompt,
      captureState: acceptedCapture,
      stableForMs: 120000,
      responseStartTimeoutMs: 90000,
    }),
    false
  );
});

test("capture state merges tail-only snapshots after the prompt scrolls out", () => {
  const prompt = "Audit the repository";
  let captureState = __testing.createAssistantCaptureState();
  captureState = __testing.advanceAssistantCaptureState(
    captureState,
    __testing.extractAssistantCaptureSnapshot({
      transcriptTexts: [
        prompt,
        "Finding 1",
        "Finding 2",
        "Finding 3",
      ],
    }, prompt)
  );
  captureState = __testing.advanceAssistantCaptureState(
    captureState,
    __testing.extractAssistantCaptureSnapshot({
      transcriptTexts: [
        "Finding 2",
        "Finding 3",
        "Finding 4",
      ],
    }, prompt)
  );

  assert.equal(captureState.incomplete, false);
  assert.equal(
    captureState.assistantText,
    ["Finding 1", "Finding 2", "Finding 3", "Finding 4"].join("\n")
  );
});

test("capture state fails loudly when a tail-only snapshot cannot be aligned", () => {
  const prompt = "Audit the repository";
  let captureState = __testing.createAssistantCaptureState();
  captureState = __testing.advanceAssistantCaptureState(
    captureState,
    __testing.extractAssistantCaptureSnapshot({
      transcriptTexts: [
        prompt,
        "Confirmed bug in src/a.ts:10",
        "Confirmed bug in src/b.ts:20",
      ],
    }, prompt)
  );
  captureState = __testing.advanceAssistantCaptureState(
    captureState,
    __testing.extractAssistantCaptureSnapshot({
      transcriptTexts: [
        "Completely different trailing text",
      ],
    }, prompt)
  );

  assert.equal(captureState.incomplete, true);
  assert.match(captureState.incompleteReason, /could not be aligned/i);
  assert.equal(
    captureState.assistantText,
    ["Confirmed bug in src/a.ts:10", "Confirmed bug in src/b.ts:20"].join("\n")
  );
});

test("assistant wait progress carries the response-start guard across polling chunks", () => {
  const prompt = "Audit this upload";
  let progress = __testing.createAssistantWaitProgress(1_000);

  progress = __testing.advanceAssistantWaitProgress(
    progress,
    {
      composerValue: "",
      isAnswering: false,
      transcriptTexts: [prompt],
    },
    prompt,
    5_000
  );

  assert.equal(__testing.assistantWaitProgressStableForMs(progress, 94_000) >= 120_000, false);
  assert.equal(
    __testing.shouldFailResponseStart({
      responseStartedEver: progress.responseStartedEver,
      state: { composerValue: "", isAnswering: false },
      prompt,
      captureState: progress.captureState,
      stableForMs: __testing.assistantWaitProgressStableForMs(progress, 126_000),
      responseStartTimeoutMs: 120_000,
    }),
    true
  );
});

test("assistant wait progress preserves captured assistant text across polling chunks", () => {
  const prompt = "Audit the repository";
  let progress = __testing.createAssistantWaitProgress(1_000);

  progress = __testing.advanceAssistantWaitProgress(
    progress,
    {
      isAnswering: true,
      transcriptTexts: [
        prompt,
        "Confirmed bug in src/alpha.ts:101 with a long overlapping explanation",
        "Confirmed bug in src/beta.ts:202 with another long overlapping explanation",
      ],
    },
    prompt,
    5_000
  );
  progress = __testing.advanceAssistantWaitProgress(
    progress,
    {
      isAnswering: false,
      transcriptTexts: [
        "Confirmed bug in src/beta.ts:202 with another long overlapping explanation",
        "Confirmed bug in src/gamma.ts:303 after the chunk boundary",
      ],
    },
    prompt,
    95_000
  );

  assert.equal(progress.captureState.incomplete, false);
  assert.equal(
    progress.captureState.assistantText,
    [
      "Confirmed bug in src/alpha.ts:101 with a long overlapping explanation",
      "Confirmed bug in src/beta.ts:202 with another long overlapping explanation",
      "Confirmed bug in src/gamma.ts:303 after the chunk boundary",
    ].join("\n")
  );
});

test("foreground recovery is only attempted for upload waits on recoverable background state errors", () => {
  assert.equal(
    __testing.shouldAttemptForegroundRecoveryForWait({
      allowForegroundRecovery: true,
      background: true,
      error: { code: "PSST_GPT_WINDOW_SHELL_ONLY_BACKGROUND" },
    }),
    true
  );

  assert.equal(
    __testing.shouldAttemptForegroundRecoveryForWait({
      allowForegroundRecovery: true,
      background: true,
      error: { code: "PSST_GPT_WINDOW_MISSING_BACKGROUND" },
    }),
    true
  );

  assert.equal(
    __testing.shouldAttemptForegroundRecoveryForWait({
      allowForegroundRecovery: false,
      background: true,
      error: { code: "PSST_GPT_WINDOW_SHELL_ONLY_BACKGROUND" },
    }),
    false
  );

  assert.equal(
    __testing.shouldAttemptForegroundRecoveryForWait({
      allowForegroundRecovery: true,
      background: false,
      error: { code: "PSST_GPT_WINDOW_SHELL_ONLY_BACKGROUND" },
    }),
    false
  );

  assert.equal(
    __testing.shouldAttemptForegroundRecoveryForWait({
      allowForegroundRecovery: true,
      background: true,
      error: { code: "PSST_GPT_RESPONSE_TIMEOUT" },
    }),
    false
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

test("verified upload audit prompts add a machine-checkable header unless exact output is requested", () => {
  const prompt = __testing.buildVerifiedUploadAuditPrompt(
    "Debug audit the uploaded repo.",
    ["/tmp/source-archive.zip"]
  );
  const exactPrompt = __testing.buildVerifiedUploadAuditPrompt(
    "reply exactly: MARKER",
    ["/tmp/source-archive.zip"]
  );

  assert.match(prompt, /PsstGPT upload verification: OK source-archive\.zip/);
  assert.match(prompt, /After that first verification line/);
  assert.equal(exactPrompt, "reply exactly: MARKER");
});

test("upload verification header parser strips the internal verification line", () => {
  const parsed = __testing.parseUploadVerificationHeader(
    [
      "PsstGPT upload verification: OK source-archive.zip",
      "",
      "Findings",
      "",
      "1. src/main.ts:10 can throw on empty input.",
    ].join("\n"),
    ["/tmp/source-archive.zip"]
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.verified, true);
  assert.equal(parsed.verifiedFiles.includes("source-archive.zip"), true);
  assert.equal(
    parsed.bodyText,
    ["Findings", "", "1. src/main.ts:10 can throw on empty input."].join("\n")
  );

  const missing = __testing.parseUploadVerificationHeader(
    "Findings only",
    ["/tmp/source-archive.zip"]
  );
  assert.equal(missing.ok, false);
  assert.match(missing.message, /required upload verification header/i);
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

test("normalizeOverallTimeoutMs treats non-positive values as disabled", () => {
  assert.equal(__testing.normalizeOverallTimeoutMs(undefined), 0);
  assert.equal(__testing.normalizeOverallTimeoutMs(null), 0);
  assert.equal(__testing.normalizeOverallTimeoutMs(0, 1800000), 0);
  assert.equal(__testing.normalizeOverallTimeoutMs(-1, 1800000), 0);
  assert.equal(__testing.normalizeOverallTimeoutMs("60000", 0), 60000);
});

test("calculateDirectAxRelayTimeoutMs disables the child timeout when response waiting is unlimited", () => {
  assert.equal(
    __testing.calculateDirectAxRelayTimeoutMs({
      timeoutMs: 0,
      uploadTimeoutMs: 2000,
      fileCount: 3,
    }),
    0
  );
});

test("calculateDirectAxRelayTimeoutMs stays bounded when the AX helper returns after send", () => {
  assert.equal(
    __testing.calculateDirectAxRelayTimeoutMs({
      timeoutMs: 0,
      uploadTimeoutMs: 2000,
      fileCount: 3,
      returnAfterSend: true,
    }),
    36000
  );
});

test("accessibility setup help text mentions the host app and helper binaries", () => {
  const helpText = __testing.buildAccessibilitySetupHelpText();
  const reminderText = __testing.buildAccessibilityReminderMessage();

  assert.match(helpText, /Terminal/);
  assert.match(helpText, /VS Code/);
  assert.match(helpText, /\/usr\/bin\/osascript/);
  assert.match(helpText, /\/usr\/bin\/swift/);
  assert.match(reminderText, /ChatGPT app/);
});

test("accessibility error detection catches both coded and message-only failures", () => {
  assert.equal(
    __testing.isAccessibilityError({ code: "MACOS_ACCESSIBILITY_DISABLED", message: "disabled" }),
    true
  );
  assert.equal(
    __testing.isAccessibilityError({ message: "Accessibility is not trusted for the current process" }),
    true
  );
  assert.equal(
    __testing.isAccessibilityError({ message: "ChatGPT window missing" }),
    false
  );
});

test("accessibility reminder rate limit allows first run and daily retries", () => {
  assert.equal(__testing.shouldShowAccessibilityReminder(undefined, 1000), true);
  assert.equal(__testing.shouldShowAccessibilityReminder("not-a-date", 1000), true);
  assert.equal(
    __testing.shouldShowAccessibilityReminder(
      "2026-06-27T00:00:00.000Z",
      Date.parse("2026-06-27T12:00:00.000Z")
    ),
    false
  );
  assert.equal(
    __testing.shouldShowAccessibilityReminder(
      "2026-06-26T00:00:00.000Z",
      Date.parse("2026-06-27T12:00:00.000Z")
    ),
    true
  );
});

test("doctor next steps map common setup failures to concrete actions", () => {
  assert.deepEqual(
    __testing.doctorNextStepsForError({ code: "MACOS_ACCESSIBILITY_DISABLED" }),
    [
      "Open System Settings > Privacy & Security > Accessibility and enable the app running Codex. If macOS prompts separately, also allow /usr/bin/osascript and /usr/bin/swift.",
    ]
  );
  assert.deepEqual(
    __testing.doctorNextStepsForError({ code: "PSST_GPT_WINDOW_SHELL_ONLY" }),
    [
      "Relaunch ChatGPT or open a fresh chat window until macOS Accessibility exposes a real chat window with a composer, then rerun PsstGPT.",
    ]
  );
});

test("doctor summary reports degraded readiness when only one relay path is available", () => {
  const result = __testing.buildDoctorResult([
    {
      name: "platform",
      status: "pass",
      ready: true,
      nextSteps: [],
    },
    {
      name: "chatgptApp",
      status: "pass",
      ready: true,
      nextSteps: [],
    },
    {
      name: "strictBackgroundTextRelay",
      status: "fail",
      ready: false,
      nextSteps: [
        "Relaunch ChatGPT or open a fresh chat window until macOS Accessibility exposes a real chat window with a composer, then rerun PsstGPT.",
      ],
    },
    {
      name: "foregroundUploadRelay",
      status: "pass",
      ready: true,
      nextSteps: [],
    },
  ]);

  assert.equal(result.overallStatus, "degraded");
  assert.equal(result.supports.strictBackgroundTextRelay, false);
  assert.equal(result.supports.foregroundUploadRelay, true);
  assert.equal(result.supports.hiddenBackgroundUploadRelay, false);
  assert.deepEqual(result.nextSteps, [
    "Relaunch ChatGPT or open a fresh chat window until macOS Accessibility exposes a real chat window with a composer, then rerun PsstGPT.",
  ]);
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

test("auditPsstGPT preflights before creating the local bundle", async () => {
  let bundleFactoryCalls = 0;
  await assert.rejects(
    auditPsstGPT({
      preflight: async () => {
        throw Object.assign(new Error("shell only"), {
          code: "PSST_GPT_WINDOW_SHELL_ONLY_BACKGROUND",
        });
      },
      bundleFactory: async () => {
        bundleFactoryCalls += 1;
        throw new Error("bundleFactory should not run");
      },
    }),
    { code: "PSST_GPT_WINDOW_SHELL_ONLY_BACKGROUND" }
  );
  assert.equal(bundleFactoryCalls, 0);
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

test("uploadAuditPsstGPT preflights before creating the upload bundle", async () => {
  let bundleFactoryCalls = 0;
  await assert.rejects(
    uploadAuditPsstGPT({
      preflight: async () => {
        throw Object.assign(new Error("shell only"), {
          code: "PSST_GPT_WINDOW_SHELL_ONLY",
        });
      },
      bundleFactory: async () => {
        bundleFactoryCalls += 1;
        throw new Error("bundleFactory should not run");
      },
    }),
    { code: "PSST_GPT_WINDOW_SHELL_ONLY" }
  );
  assert.equal(bundleFactoryCalls, 0);
});

test("createPsstGPTUploadBundle writes one source archive only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "psst-gpt-upload-test-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".agents", "plugins"), { recursive: true });
    await mkdir(path.join(root, ".arc"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "src", "a.js"), `${"a".repeat(900)}\n`, "utf8");
    await writeFile(path.join(root, "src", "b.js"), `${"b".repeat(900)}\n`, "utf8");
    await writeFile(path.join(root, "README.md"), "# Demo\n", "utf8");
    await writeFile(path.join(root, ".agents", "plugins", "marketplace.json"), "{}\n", "utf8");
    await writeFile(path.join(root, ".arc", "telemetry.jsonl"), "ignored-agent-state\n", "utf8");
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "ignored\n", "utf8");

    const bundle = await createPsstGPTUploadBundle({
      root,
      maxSingleFileBytes: 2048,
    });

    assert.equal(bundle.root, root);
    assert.equal(bundle.archivePath.endsWith("source-archive.zip"), true);
    assert.deepEqual(bundle.attachmentPaths, [bundle.archivePath]);
    assert.equal(bundle.files.some((file) => file.path === "src/a.js"), true);
    assert.equal(bundle.files.some((file) => file.path === "src/b.js"), true);
    assert.equal(bundle.files.some((file) => file.path === "README.md"), true);
    assert.equal(bundle.files.some((file) => file.path === ".agents/plugins/marketplace.json"), false);
    assert.equal(bundle.skipped.some((entry) => entry.path === "node_modules"), true);
    assert.equal(bundle.skipped.some((entry) => entry.path === ".agents"), true);
    assert.equal(bundle.skipped.some((entry) => entry.path === ".arc"), true);
    assert.equal(bundle.shards.length, 1);
    assert.equal(bundle.archives.length, 1);
    assert.equal(bundle.shards[0].name, "source-archive.zip");
    assert.deepEqual((await readdir(bundle.outputDir)).sort(), ["source-archive.zip"]);
    const archiveStat = await stat(bundle.shards[0].path);
    assert.equal(archiveStat.isFile(), true);
    assert.equal(archiveStat.size > 0, true);
    const archiveListing = await execFileAsync("unzip", ["-l", bundle.archivePath]);
    assert.match(archiveListing.stdout, /src\/a\.js/);
    assert.match(archiveListing.stdout, /src\/b\.js/);
    assert.doesNotMatch(archiveListing.stdout, /upload-manifest\.json/);
    assert.doesNotMatch(archiveListing.stdout, /\.agents\/plugins\/marketplace\.json/);
    assert.doesNotMatch(archiveListing.stdout, /\.arc\/telemetry\.jsonl/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistUploadAuditFailure writes failure artifacts once a bundle exists", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "psst-gpt-upload-failure-"));
  try {
    const bundle = {
      bundleId: "bundle-failure-test",
      outputDir,
      archivePath: path.join(outputDir, "source-archive.zip"),
      attachmentPaths: [path.join(outputDir, "source-archive.zip")],
    };
    await writeFile(bundle.archivePath, "zip-bytes", "utf8");

    const failure = await __testing.persistUploadAuditFailure({
      error: Object.assign(new Error("shell only"), {
        code: "PSST_GPT_WINDOW_SHELL_ONLY",
        cause: Object.assign(new Error("osascript timed out"), {
          code: "ETIMEDOUT",
          signal: "SIGTERM",
          killed: true,
        }),
      }),
      bundle,
      requestedPrompt: "Audit the uploaded archive.",
      attachmentPaths: bundle.attachmentPaths,
      relaySessionId: "app-test",
    });

    assert.equal(failure.ok, false);
    assert.equal(failure.status, "failed");
    assert.equal(failure.code, "PSST_GPT_WINDOW_SHELL_ONLY");
    assert.equal(await stat(failure.responsePath).then(() => true), true);
    assert.equal(await stat(failure.resultPath).then(() => true), true);
    const resultJson = JSON.parse(await readFile(failure.resultPath, "utf8"));
    assert.equal(resultJson.code, "PSST_GPT_WINDOW_SHELL_ONLY");
    assert.equal(resultJson.bundle.metadataPath.endsWith("upload-bundle.json"), true);
    assert.equal(resultJson.error.cause.code, "ETIMEDOUT");
    assert.equal(resultJson.error.cause.signal, "SIGTERM");
    const responseText = await readFile(failure.responsePath, "utf8");
    assert.match(responseText, /Upload Audit Failed/);
    assert.match(responseText, /shell only/i);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
