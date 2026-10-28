import Carbon

/// A system-wide hotkey registered through Carbon. Unlike an NSEvent global
/// monitor, this needs no Accessibility permission.
final class HotKey {
    private static var handlers: [UInt32: () -> Void] = [:]
    private static var handlerInstalled = false

    private var ref: EventHotKeyRef?

    /// Non-nil when another app (or another copy of Dash) already owns this key combination.
    let registrationError: OSStatus?

    init(id: UInt32, keyCode: Int, modifiers: Int, handler: @escaping () -> Void) {
        HotKey.installHandlerIfNeeded()
        HotKey.handlers[id] = handler
        let hotKeyID = EventHotKeyID(signature: OSType(0x4441_5348), id: id) // 'DASH'
        let status = RegisterEventHotKey(UInt32(keyCode), UInt32(modifiers), hotKeyID,
                                         GetApplicationEventTarget(), 0, &ref)
        registrationError = status == noErr ? nil : status
        if status != noErr { Log.write("hotkey \(id) failed to register (OSStatus \(status))") }
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
    }

    private static func installHandlerIfNeeded() {
        guard !handlerInstalled else { return }
        handlerInstalled = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var hotKeyID = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject),
                              EventParamType(typeEventHotKeyID), nil,
                              MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
            HotKey.handlers[hotKeyID.id]?()
            return noErr
        }, 1, &spec, nil, nil)
    }
}
