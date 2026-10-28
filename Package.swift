// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "Dash",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Dash", path: "Sources/Dash")
    ]
)
