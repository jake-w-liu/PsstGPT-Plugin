import ApplicationServices
import AppKit
import Foundation

struct Input: Decodable {
    let prompt: String
    let filePaths: [String]
    let newChat: Bool?
    let timeoutMs: Double?
    let uploadTimeoutMs: Double?
    let responseStableMs: Double?
    let pollIntervalMs: Double?
}

struct NodeRecord {
    let element: AXUIElement
    let role: String
    let label: String
    let enabled: Bool?
    let position: CGPoint?
    let size: CGSize?
}

enum AxUploadError: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        switch self {
        case .message(let value): return value
        }
    }
}

func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ code: String, _ message: String) -> Never {
    let payload: [String: Any] = [
        "ok": false,
        "code": code,
        "message": message,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) {
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data("\n".utf8))
    } else {
        FileHandle.standardError.write(Data("\(code): \(message)\n".utf8))
    }
    exit(1)
}

func sleepMs(_ milliseconds: Double) {
    Thread.sleep(forTimeInterval: max(0, milliseconds) / 1000.0)
}

func normalizeTimeoutMs(_ timeoutMs: Double?, fallback: Double) -> Double {
    guard let timeoutMs else { return fallback }
    guard timeoutMs.isFinite else { return fallback }
    return timeoutMs <= 0 ? 0 : max(1, timeoutMs.rounded(.down))
}

func attr<T>(_ element: AXUIElement, _ name: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success, let value else {
        return nil
    }
    return value as? T
}

func stringAttr(_ element: AXUIElement, _ name: String) -> String {
    if let value: String = attr(element, name) { return value }
    if let value: NSAttributedString = attr(element, name) { return value.string }
    return ""
}

func boolAttr(_ element: AXUIElement, _ name: String) -> Bool? {
    attr(element, name)
}

func pointAttr(_ element: AXUIElement, _ name: String) -> CGPoint? {
    guard let value: AXValue = attr(element, name) else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(value, .cgPoint, &point) ? point : nil
}

func sizeAttr(_ element: AXUIElement, _ name: String) -> CGSize? {
    guard let value: AXValue = attr(element, name) else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(value, .cgSize, &size) ? size : nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    attr(element, kAXChildrenAttribute) ?? []
}

func descendants(_ root: AXUIElement, limit: Int = 12_000) -> [AXUIElement] {
    var output: [AXUIElement] = []
    var stack = [root]
    while let current = stack.popLast(), output.count < limit {
        let items = children(current)
        output.append(contentsOf: items)
        stack.append(contentsOf: items.reversed())
    }
    return output
}

func normalize(_ value: String) -> String {
    value
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func label(_ element: AXUIElement) -> String {
    normalize([
        stringAttr(element, kAXDescriptionAttribute),
        stringAttr(element, kAXTitleAttribute),
        stringAttr(element, kAXValueAttribute),
    ].filter { !$0.isEmpty }.joined(separator: " "))
}

func record(_ element: AXUIElement) -> NodeRecord {
    NodeRecord(
        element: element,
        role: stringAttr(element, kAXRoleAttribute),
        label: label(element),
        enabled: boolAttr(element, kAXEnabledAttribute),
        position: pointAttr(element, kAXPositionAttribute),
        size: sizeAttr(element, kAXSizeAttribute)
    )
}

func press(_ record: NodeRecord, _ name: String) throws {
    let error = AXUIElementPerformAction(record.element, kAXPressAction as CFString)
    guard error == .success else {
        throw AxUploadError.message("Could not press \(name): AX error \(error.rawValue), label=\(record.label)")
    }
}

func click(_ record: NodeRecord, _ name: String) throws {
    guard let position = record.position, let size = record.size else {
        throw AxUploadError.message("Could not click \(name): geometry unavailable, label=\(record.label)")
    }
    let center = CGPoint(x: position.x + (size.width / 2), y: position.y + (size.height / 2))
    let source = CGEventSource(stateID: .hidSystemState)
    let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: center, mouseButton: .left)
    let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: center, mouseButton: .left)
    let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: center, mouseButton: .left)
    move?.post(tap: .cghidEventTap)
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
    sleepMs(120)
}

func setText(_ record: NodeRecord, _ text: String) throws {
    let error = AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, text as CFTypeRef)
    guard error == .success else {
        throw AxUploadError.message("Could not set composer text: AX error \(error.rawValue)")
    }
}

func key(_ code: CGKeyCode, flags: CGEventFlags = []) {
    let source = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)!
    down.flags = flags
    down.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)!
    up.flags = flags
    up.post(tap: .cghidEventTap)
    sleepMs(80)
}

struct PasteboardSnapshot {
    let items: [[NSPasteboard.PasteboardType: Data]]

    init(_ pasteboard: NSPasteboard) {
        items = (pasteboard.pasteboardItems ?? []).compactMap { item in
            var values: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) {
                    values[type] = data
                }
            }
            return values.isEmpty ? nil : values
        }
    }

    func restore(_ pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        let restoredItems = items.map { values in
            let item = NSPasteboardItem()
            for (type, data) in values {
                item.setData(data, forType: type)
            }
            return item
        }
        if !restoredItems.isEmpty {
            pasteboard.writeObjects(restoredItems)
        }
    }
}

func waitFor<T>(_ timeoutMs: Double, intervalMs: Double = 250, _ block: () throws -> T?) throws -> T {
    let normalizedTimeoutMs = timeoutMs.isFinite ? timeoutMs : 0
    let deadline = normalizedTimeoutMs > 0
        ? Date().addingTimeInterval(normalizedTimeoutMs / 1000.0)
        : nil
    var lastError: Error?
    while deadline == nil || Date() < deadline! {
        do {
            if let result = try block() { return result }
        } catch {
            lastError = error
        }
        sleepMs(intervalMs)
    }
    if let lastError { throw lastError }
    throw AxUploadError.message("Timed out after \(Int(normalizedTimeoutMs)) ms")
}

func chatGPTAppElement() throws -> AXUIElement {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.chat").first else {
        throw AxUploadError.message("ChatGPT is not running")
    }
    _ = app.activate()
    sleepMs(500)
    return AXUIElementCreateApplication(app.processIdentifier)
}

func chatWindow(_ appElement: AXUIElement) throws -> AXUIElement {
    let windows: [AXUIElement] = attr(appElement, kAXWindowsAttribute) ?? []
    for window in windows {
        if descendants(window, limit: 1_000).contains(where: { stringAttr($0, kAXRoleAttribute) == kAXTextAreaRole }) {
            return window
        }
    }
    if let first = windows.first { return first }
    throw AxUploadError.message("No ChatGPT window is available")
}

func firstRecord(_ root: AXUIElement, role: String? = nil, matching pattern: String? = nil) -> NodeRecord? {
    let regex = pattern.flatMap { try? NSRegularExpression(pattern: $0, options: [.caseInsensitive]) }
    for element in descendants(root) {
        let item = record(element)
        if let role, item.role != role { continue }
        if let regex {
            let range = NSRange(item.label.startIndex..<item.label.endIndex, in: item.label)
            if regex.firstMatch(in: item.label, range: range) == nil { continue }
        }
        return item
    }
    return nil
}

func composer(_ window: AXUIElement) -> NodeRecord? {
    firstRecord(window, role: kAXTextAreaRole)
}

func snapshot(_ window: AXUIElement) -> [String: Any] {
    let records = descendants(window).map(record)
    let composerRecord = records.first { $0.role == kAXTextAreaRole }
    let composerTop = composerRecord?.position?.y ?? CGFloat.greatestFiniteMagnitude
    let staticTexts = records
        .filter { $0.role == kAXStaticTextRole && !$0.label.isEmpty && (($0.position?.y ?? 0) < composerTop - 8) }
        .sorted {
            let ly = $0.position?.y ?? 0
            let ry = $1.position?.y ?? 0
            if ly != ry { return ly < ry }
            return ($0.position?.x ?? 0) < ($1.position?.x ?? 0)
        }
        .map(\.label)
    let buttonLabels = records
        .filter { $0.role == kAXButtonRole && !$0.label.isEmpty }
        .map(\.label)
    let isAnswering = buttonLabels.contains {
        $0.range(of: "\\b(stop|cancel)\\b.*\\b(generating|answer|response|stream|thinking)?\\b|\\b(analyzing|thinking)\\b",
                 options: [.regularExpression, .caseInsensitive]) != nil
    }
    return [
        "title": stringAttr(window, kAXTitleAttribute).isEmpty ? "ChatGPT" : stringAttr(window, kAXTitleAttribute),
        "bundleId": "com.openai.chat",
        "processName": "ChatGPT",
        "frontmostProcessName": "ChatGPT",
        "background": false,
        "hasComposer": composerRecord != nil,
        "composerValue": composerRecord?.label ?? "",
        "visibleModelLabel": buttonLabels.first { $0.range(of: "5\\.|4\\.|o3|Instant|Thinking|Pro", options: [.regularExpression, .caseInsensitive]) != nil } ?? "",
        "transcriptTexts": staticTexts,
        "visibleText": staticTexts.joined(separator: "\n"),
        "buttonLabels": buttonLabels,
        "isAnswering": isAnswering,
        "directAx": true,
    ]
}

func assistantText(from state: [String: Any], prompt: String) -> String {
    let transcript = state["transcriptTexts"] as? [String] ?? []
    let promptNeedle = normalize(prompt).lowercased()
    var promptIndex = -1
    for index in stride(from: transcript.count - 1, through: 0, by: -1) {
        let text = normalize(transcript[index]).lowercased()
        if text == promptNeedle ||
            (promptNeedle.count >= 80 && text.contains(String(promptNeedle.prefix(80)))) ||
            (text.count >= 80 && promptNeedle.contains(String(text.prefix(80)))) {
            promptIndex = index
            break
        }
    }
    let slice = promptIndex >= 0 ? transcript.dropFirst(promptIndex + 1) : transcript[...]
    let ignored = Set(["Ask anything", "Thinking", "Pro thinking", "Searching", "Searching the web"])
    return slice
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty && !ignored.contains($0) && normalize($0).lowercased() != promptNeedle }
        .joined(separator: "\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func chooseNewChat(_ appElement: AXUIElement) throws {
    let window = try chatWindow(appElement)
    if let button = firstRecord(window, role: kAXButtonRole, matching: "^New chat$") {
        try press(button, "New chat")
    } else {
        key(45, flags: [.maskCommand])
    }
    sleepMs(1_000)
}

func waitForComposer(_ appElement: AXUIElement, timeoutMs: Double) throws -> (AXUIElement, NodeRecord) {
    try waitFor(timeoutMs, intervalMs: 250) {
        let window = try chatWindow(appElement)
        guard let item = composer(window) else { return nil }
        return (window, item)
    }
}

func didSendStart(_ appElement: AXUIElement, prompt: String) throws -> Bool {
    let window = try chatWindow(appElement)
    let state = snapshot(window)
    if (state["isAnswering"] as? Bool) == true {
        return true
    }
    guard let currentComposer = composer(window) else {
        return true
    }
    let currentValue = normalize(currentComposer.label)
    return currentValue.isEmpty || currentValue != normalize(prompt)
}

func pressSendAndVerify(_ record: NodeRecord, appElement: AXUIElement, prompt: String) throws -> Bool {
    try press(record, "Send")
    sleepMs(250)
    do {
        _ = try waitFor(3_000, intervalMs: 100) {
            try didSendStart(appElement, prompt: prompt) ? true : nil
        } as Bool
        return true
    } catch {
        return false
    }
}

func labelsContainUploadNeedle(_ labels: [String], fileName: String, prefix: String) -> Bool {
    let haystack = labels.joined(separator: "\n").lowercased()
    return haystack.contains(fileName) || haystack.contains(prefix)
}

func recordsContainUploadNeedle(_ records: [NodeRecord], fileName: String, prefix: String) -> Bool {
    labelsContainUploadNeedle(records.map { $0.label }, fileName: fileName, prefix: prefix)
}

func uploadDialogAcceptButton(_ appElement: AXUIElement) -> NodeRecord? {
    descendants(appElement).map(record).first { item in
        guard item.role == kAXButtonRole, item.enabled ?? true else {
            return false
        }
        return normalize(item.label).range(of: "^(Open|Choose|Select)$",
                                           options: [.regularExpression, .caseInsensitive]) != nil
    }
}

func uploadDialogFileRecord(_ appElement: AXUIElement, fileName: String, prefix: String) -> NodeRecord? {
    let records = descendants(appElement).map(record)
    let exact = records.first { item in
        guard item.role != kAXButtonRole, item.position != nil, item.size != nil else {
            return false
        }
        return item.label.lowercased() == fileName
    }
    if let exact { return exact }
    return records.first { item in
        guard item.role != kAXButtonRole, item.position != nil, item.size != nil else {
            return false
        }
        let lower = item.label.lowercased()
        return lower.contains(fileName) || lower == prefix
    }
}

func selectUploadDialogFile(_ record: NodeRecord) {
    if AXUIElementPerformAction(record.element, kAXPressAction as CFString) == .success {
        sleepMs(150)
        return
    }
    try? click(record, "Upload file row")
}

func driveUploadSearchFallback(_ fileName: String) {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(fileName, forType: .string)
    key(9, flags: [.maskCommand])
    sleepMs(250)
    key(125)
    sleepMs(150)
    key(36)
    sleepMs(250)
}

func uploadFile(_ filePath: String, appElement: AXUIElement, uploadTimeoutMs: Double) throws {
    let (window, composerRecord) = try waitForComposer(appElement, timeoutMs: 15_000)
    guard let composerPosition = composerRecord.position, let composerSize = composerRecord.size else {
        throw AxUploadError.message("Composer geometry is unavailable")
    }
    let composerBottom = composerPosition.y + min(composerSize.height, 360)
    let buttons = descendants(window).map(record)
        .filter { $0.role == kAXButtonRole && ($0.enabled ?? true) && $0.position != nil && $0.size != nil }
    let candidates = buttons.filter { item in
        if item.label.range(of: "Attach", options: [.caseInsensitive]) != nil { return true }
        let position = item.position!
        let size = item.size!
        let centerY = position.y + size.height / 2
        return position.x >= composerPosition.x - 12 &&
            position.x <= composerPosition.x + 90 &&
            centerY >= composerPosition.y - 20 &&
            centerY <= composerBottom + 80 &&
            size.width >= 10 &&
            size.width <= 55 &&
            size.height >= 10 &&
            size.height <= 55
    }.sorted { ($0.position!.x, $0.size!.width) < ($1.position!.x, $1.size!.width) }
    guard let attach = candidates.first else {
        throw AxUploadError.message("Could not find the ChatGPT Attach button")
    }
    try press(attach, "Attach")
    sleepMs(400)
    let uploadItem: NodeRecord = try waitFor(5_000, intervalMs: 100) {
        descendants(appElement).map(record).first {
            $0.role == kAXMenuItemRole && $0.label.range(of: "Upload file", options: [.caseInsensitive]) != nil
        }
    }
    try press(uploadItem, "Upload file")
    sleepMs(800)

    let pasteboard = NSPasteboard.general
    let pasteboardSnapshot = PasteboardSnapshot(pasteboard)
    do {
        pasteboard.clearContents()
        pasteboard.setString(filePath, forType: .string)
        defer { pasteboardSnapshot.restore(pasteboard) }
        key(5, flags: [.maskCommand, .maskShift])
        sleepMs(400)
        key(9, flags: [.maskCommand])
        sleepMs(200)
        key(36)
    }
    sleepMs(900)

    let fileName = URL(fileURLWithPath: filePath).lastPathComponent.lowercased()
    let prefix = String(fileName.prefix(max(8, min(18, fileName.count))))
    var didTrySearchFallback = false
    _ = try waitFor(uploadTimeoutMs, intervalMs: 500) {
        let appRecords = descendants(appElement).map(record)
        if let fileRecord = uploadDialogFileRecord(appElement, fileName: fileName, prefix: prefix) {
            selectUploadDialogFile(fileRecord)
        }
        if recordsContainUploadNeedle(appRecords, fileName: fileName, prefix: prefix),
           let accept = uploadDialogAcceptButton(appElement) {
            try? press(accept, "Open")
            sleepMs(300)
        } else if !didTrySearchFallback {
            driveUploadSearchFallback(fileName)
            didTrySearchFallback = true
        }
        let window = try chatWindow(appElement)
        let windowLabels = descendants(window).map { label($0) }
        return labelsContainUploadNeedle(windowLabels, fileName: fileName, prefix: prefix) ? true : nil
    } as Bool
}

func sendIfNeeded(_ appElement: AXUIElement, prompt: String) throws {
    var window = try chatWindow(appElement)
    if (snapshot(window)["isAnswering"] as? Bool) == true { return }
    if let send = firstRecord(window, role: kAXButtonRole, matching: "^Send$"), send.enabled ?? true,
       try pressSendAndVerify(send, appElement: appElement, prompt: prompt) {
        return
    }
    if let currentComposer = composer(window), let composerPosition = currentComposer.position, let composerSize = currentComposer.size {
        let composerBottom = composerPosition.y + min(composerSize.height, 360)
        let candidates = descendants(window).map(record).filter { item in
            guard item.role == kAXButtonRole, item.enabled ?? true, let position = item.position, let size = item.size else {
                return false
            }
            if normalize(item.label).range(of: "ChatGPT|New chat|Share|Move|Sidebar|close|minimize|full screen|5\\.[0-9]|4\\.5|o3|Pro|Thinking",
                                           options: [.regularExpression, .caseInsensitive]) != nil {
                return false
            }
            let centerY = position.y + size.height / 2
            return position.x > composerPosition.x + max(180, composerSize.width * 0.35) &&
                centerY >= composerPosition.y - 40 &&
                centerY <= composerBottom + 80 &&
                size.width >= 16 &&
                size.width <= 80 &&
                size.height >= 16 &&
                size.height <= 80
        }.sorted { ($0.position?.x ?? 0) > ($1.position?.x ?? 0) }
        for candidate in candidates {
            if try pressSendAndVerify(candidate, appElement: appElement, prompt: prompt) {
                return
            }
        }
    }
    key(36)
    sleepMs(250)
    window = try chatWindow(appElement)
    if (snapshot(window)["isAnswering"] as? Bool) != true {
        throw AxUploadError.message("Could not find or activate the ChatGPT Send button")
    }
}

func run(_ input: Input) throws -> [String: Any] {
    guard !normalize(input.prompt).isEmpty else {
        throw AxUploadError.message("Prompt is empty")
    }
    for filePath in input.filePaths {
        guard FileManager.default.fileExists(atPath: filePath) else {
            throw AxUploadError.message("Upload file does not exist: \(filePath)")
        }
    }
    let trustPromptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let trustOptions = [trustPromptKey: true] as CFDictionary
    guard AXIsProcessTrustedWithOptions(trustOptions) else {
        throw AxUploadError.message("macOS Accessibility automation is not enabled for /usr/bin/swift")
    }

    let appElement = try chatGPTAppElement()
    if input.newChat != false {
        try chooseNewChat(appElement)
    }
    var (_, composerRecord) = try waitForComposer(appElement, timeoutMs: 15_000)
    try setText(composerRecord, input.prompt)
    sleepMs(300)
    (_, composerRecord) = try waitForComposer(appElement, timeoutMs: 5_000)
    guard normalize(composerRecord.label) == normalize(input.prompt) else {
        throw AxUploadError.message("Composer text verification failed")
    }

    let uploadTimeoutMs = normalizeTimeoutMs(input.uploadTimeoutMs, fallback: 120_000)
    for filePath in input.filePaths {
        try uploadFile(filePath, appElement: appElement, uploadTimeoutMs: uploadTimeoutMs)
    }
    try sendIfNeeded(appElement, prompt: input.prompt)

    let timeoutMs = normalizeTimeoutMs(input.timeoutMs, fallback: 0)
    let stableMs = input.responseStableMs ?? 8_000
    let pollMs = input.pollIntervalMs ?? 2_000
    let deadline = timeoutMs > 0
        ? Date().addingTimeInterval(timeoutMs / 1000.0)
        : nil
    var lastAssistantText = ""
    var lastChangedAt = Date()

    while deadline == nil || Date() < deadline! {
        sleepMs(pollMs)
        let window = try chatWindow(appElement)
        let state = snapshot(window)
        let text = assistantText(from: state, prompt: input.prompt)
        if text != lastAssistantText {
            lastAssistantText = text
            lastChangedAt = Date()
        }
        let answering = state["isAnswering"] as? Bool ?? false
        if !answering && !lastAssistantText.isEmpty && Date().timeIntervalSince(lastChangedAt) * 1000 >= stableMs {
            return [
                "ok": true,
                "status": "complete",
                "assistantText": lastAssistantText,
                "state": state,
            ]
        }
    }

    throw AxUploadError.message("ChatGPT did not finish answering before the timeout")
}

do {
    guard CommandLine.arguments.count >= 2 else {
        throw AxUploadError.message("Missing JSON input argument")
    }
    let data = Data(CommandLine.arguments[1].utf8)
    let input = try JSONDecoder().decode(Input.self, from: data)
    try emit(try run(input))
} catch let AxUploadError.message(message) where message.localizedCaseInsensitiveContains("Accessibility") {
    fail("MACOS_ACCESSIBILITY_DISABLED", message)
} catch {
    fail("PSST_GPT_DIRECT_AX_FAILED", String(describing: error))
}
