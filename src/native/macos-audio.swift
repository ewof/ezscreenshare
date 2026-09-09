import Foundation
import ScreenCaptureKit
import AVFoundation
import AppKit

// stdout is newline-delimited JSON; PCM is interleaved stereo Float32 at 48 kHz.
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}

@available(macOS 13.0, *)
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    var stream: SCStream?
    let queue = DispatchQueue(label: "ezscreenshare.audio")
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["error": error.localizedDescription])
        exit(1)
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid,
              let description = sampleBuffer.formatDescription else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0, format.commonFormat == .pcmFormatFloat32,
              let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
        pcm.frameLength = AVAudioFrameCount(frames)
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(frames), into: pcm.mutableAudioBufferList) == noErr,
              let channels = pcm.floatChannelData else { return }
        var samples = [Float](repeating: 0, count: frames * 2)
        let count = Int(format.channelCount)
        for frame in 0..<frames {
            for channel in 0..<2 {
                let source = min(channel, count - 1)
                samples[frame * 2 + channel] = format.isInterleaved ? channels[0][frame * count + source] : channels[source][frame]
            }
        }
        samples.withUnsafeBytes { emit(["pcm": Data($0).base64EncodedString()]) }
    }
    func start(mode: String, apps: [String]) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw NSError(domain: "ezscreenshare", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display is available for audio capture."])
        }
        let hostBundle = NSRunningApplication(processIdentifier: getppid())?.bundleIdentifier
        func selectedApps(_ content: SCShareableContent) -> [SCRunningApplication] {
            content.applications.filter {
                if $0.bundleIdentifier == hostBundle { return mode != "include" }
                return apps.contains($0.bundleIdentifier)
            }
        }
        let selected = selectedApps(content)
        let filter = mode == "include"
            ? SCContentFilter(display: display, including: selected, exceptingWindows: [])
            : SCContentFilter(display: display, excludingApplications: selected, exceptingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.capturesAudio = true
        configuration.sampleRate = 48000
        configuration.channelCount = 2
        configuration.excludesCurrentProcessAudio = true
        let next = SCStream(filter: filter, configuration: configuration, delegate: self)
        try next.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        stream = next
        try await next.startCapture()
        emit(["ready": true])
        // Refresh process IDs so restarting an included/excluded app keeps its policy.
        var signature = "\(display.displayID):" + selected.map { String($0.processID) }.sorted().joined(separator: ",")
        while !Task.isCancelled {
            try await Task.sleep(nanoseconds: 1_000_000_000)
            let fresh = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = fresh.displays.first else { continue }
            let selected = selectedApps(fresh)
            let nextSignature = "\(display.displayID):" + selected.map { String($0.processID) }.sorted().joined(separator: ",")
            if signature == nextSignature { continue }
            signature = nextSignature
            let filter = mode == "include"
                ? SCContentFilter(display: display, including: selected, exceptingWindows: [])
                : SCContentFilter(display: display, excludingApplications: selected, exceptingWindows: [])
            try await next.updateContentFilter(filter)
        }
    }
}

@main struct Main {
    static func main() async {
        guard #available(macOS 13.0, *) else { emit(["error": "macOS 13 or newer is required for application audio capture."]); exit(1) }
        // Exit when Electron closes its pipe (including crashes).
        DispatchQueue.global().async {
            while !FileHandle.standardInput.availableData.isEmpty {}
            exit(0)
        }
        do {
            if CommandLine.arguments.dropFirst().first == "list" {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                var seen = Set<String>()
                let hostBundle = NSRunningApplication(processIdentifier: getppid())?.bundleIdentifier
                let apps = content.applications.compactMap { app -> [String: Any]? in
                    guard !app.bundleIdentifier.isEmpty, app.bundleIdentifier != hostBundle,
                          NSRunningApplication(processIdentifier: app.processID)?.activationPolicy != .prohibited,
                          seen.insert(app.bundleIdentifier).inserted else { return nil }
                    return ["id": "app:" + app.bundleIdentifier, "label": app.applicationName, "monitor": false, "running": true]
                }
                emit(["sources": apps])
            } else {
                let raw = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "{}"
                let selection = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] ?? [:]
                let capture = Capture()
                try await capture.start(mode: selection["mode"] as? String ?? "exclude", apps: selection["apps"] as? [String] ?? [])
            }
        } catch {
            emit(["error": "macOS audio capture: \(error.localizedDescription). Allow Screen & System Audio Recording in System Settings, then restart the desktop app."])
            exit(1)
        }
    }
}
