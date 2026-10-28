import AppKit
import CoreImage.CIFilterBuiltins
import ServiceManagement
import SwiftUI

/// The Dash hub section of Settings: pairing this Mac with the hub on the PC, pairing phones through
/// it, the devices it knows, and the phone app's Expo Go code.
struct HubSettingsSection: View {
    @ObservedObject var hub: HubClient
    @State private var address = HubClient.defaultURL
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?
    @State private var pairingPhone = false
    @State private var showingAppCode = false
    @State private var loginStatus = LoginItem.status

    var body: some View {
        Section("Dash hub") {
            if hub.isPaired { paired } else { unpaired }
            if let error {
                Text(error).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            Toggle("Open Dash at login", isOn: Binding(
                get: { loginStatus == .enabled || loginStatus == .requiresApproval },
                set: { enabled in
                    do {
                        try LoginItem.set(enabled)
                    } catch {
                        self.error = error.localizedDescription
                    }
                    loginStatus = LoginItem.status
                }))
            if loginStatus == .requiresApproval {
                HStack {
                    Text("Allow Dash in System Settings › Login Items.").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Open") { SMAppService.openSystemSettingsLoginItems() }
                }
            }
        }
        .sheet(isPresented: $pairingPhone) {
            PhonePairingSheet(hub: hub) { pairingPhone = false }
        }
        .sheet(isPresented: $showingAppCode) {
            if let app = hub.credentials?.app {
                AppCodeSheet(url: app) { showingAppCode = false }
            }
        }
    }

    @ViewBuilder private var unpaired: some View {
        Text("Pair this Mac with the hub on your PC so Today and the to-do list match your phone. For a code, run `npm run pair` in ~/Dash/hub on the hub.")
            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        TextField("Hub address", text: $address, prompt: Text("wss://dash-hub.<tailnet>.ts.net"))
        TextField("6-digit code", text: $code)
        HStack {
            Spacer()
            if busy { ProgressView().controlSize(.small) }
            Button("Pair This Mac") {
                busy = true
                error = nil
                Task {
                    do {
                        try await hub.pair(url: address, code: code)
                        code = ""
                    } catch {
                        self.error = error.localizedDescription
                    }
                    busy = false
                }
            }
            .disabled(busy || address.trimmingCharacters(in: .whitespaces).isEmpty
                      || code.trimmingCharacters(in: .whitespaces).count != 6)
        }
    }

    @ViewBuilder private var paired: some View {
        LabeledContent(hub.credentials?.hub ?? "Hub") {
            switch hub.state {
            case .online: Text("Connected").foregroundStyle(.green)
            case .connecting: Text("Connecting…").foregroundStyle(.secondary)
            case .offline: Button("Offline · Retry") { hub.reconnectNow() }
            case .unpaired: Text("Not paired").foregroundStyle(.secondary)
            }
        }
        if let storeError = hub.storeError {
            Text(storeError).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
        }
        ForEach(hub.devices) { device in
            let isThisMac = device.role == "mac" && device.name == hub.credentials?.device
            HStack {
                Image(systemName: device.role == "mac" ? "laptopcomputer" : "iphone").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(device.name + (isThisMac ? " (this Mac)" : ""))
                    Text(device.online ? "Connected"
                         : "Last seen \(device.lastSeen?.formatted(.relative(presentation: .named)) ?? "never")")
                        .font(.caption)
                        .foregroundStyle(device.online ? .green : .secondary)
                }
                Spacer()
                if !isThisMac { Button("Remove") { remove(device) }.disabled(!hub.isOnline) }
            }
        }
        HStack {
            Button("Pair a Phone…") { pairingPhone = true }.disabled(!hub.isOnline)
            if hub.credentials?.app != nil { Button("Phone App…") { showingAppCode = true } }
        }
        HStack {
            Spacer()
            Button("Unpair This Mac", role: .destructive) { hub.unpair() }
        }
        Text("The hub runs on your PC, so your phone keeps working with this Mac closed. Lecture recording and the ⌥A lens still run on this Mac.")
            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }

    private func remove(_ device: HubClient.Device) {
        error = nil
        Task {
            do {
                _ = try await hub.request("devices.remove", ["device": device.id])
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// A one-time code from the hub, as a QR the phone's Pair screen scans.
private struct PhonePairingSheet: View {
    @ObservedObject var hub: HubClient
    var close: () -> Void
    @State private var code: String?
    @State private var expires = Date.distantPast
    @State private var error: String?

    var body: some View {
        VStack(spacing: 14) {
            Text("Pair a Phone").font(.headline)
            if let code, let url = hub.credentials?.url {
                Image(nsImage: QRCode.image(for: ["v": 1, "url": url, "code": code]))
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 200, height: 200)
                Text("Scan this in the Dash app on your phone.").foregroundStyle(.secondary)
                Text("Or type \(url) and the code below.")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                Text(code)
                    .font(.system(size: 30, weight: .semibold, design: .monospaced))
                    .tracking(6)
                    .textSelection(.enabled)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let left = max(0, Int(expires.timeIntervalSince(context.date)))
                    Text(left > 0 ? "Expires in \(left / 60):\(String(format: "%02d", left % 60))" : "Expired")
                        .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
                Button("New Code") { Task { await fetch() } }
            } else if let error {
                Text(error).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            } else {
                ProgressView()
            }
            Button("Done", action: close).keyboardShortcut(.defaultAction)
        }
        .padding(24)
        .frame(width: 320)
        .task { await fetch() }
    }

    private func fetch() async {
        do {
            let result = try await hub.request("pair.start")
            code = result["code"] as? String
            expires = HubClient.date(result["expires"]) ?? Date().addingTimeInterval(300)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The Expo Go address as a QR code, for the iPhone Camera.
struct AppCodeSheet: View {
    let url: String
    var close: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Text("Open Dash on Your Phone").font(.headline)
            Image(nsImage: QRCode.image(for: url))
                .interpolation(.none)
                .resizable()
                .frame(width: 200, height: 200)
            Text("Scan with the iPhone Camera; it opens in Expo Go. Or type \(url) in Expo Go.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Button("Done", action: close).keyboardShortcut(.defaultAction)
        }
        .padding(24)
        .frame(width: 320)
    }
}

enum QRCode {
    static func image(for payload: [String: Any]) -> NSImage {
        let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
        return image(for: String(decoding: data, as: UTF8.self))
    }

    static func image(for text: String) -> NSImage {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return NSImage() }
        let rep = NSCIImageRep(ciImage: output)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}

/// Dash as a login item, so it's open (and connected to the hub) after the Mac restarts.
enum LoginItem {
    static var status: SMAppService.Status { SMAppService.mainApp.status }

    static func set(_ enabled: Bool) throws {
        if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }
}
