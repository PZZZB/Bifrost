import Foundation
import AppKit
import ApplicationServices

// Read only public network-probe text and UI labels; never read form values.
let pid = pid_t(CommandLine.arguments[1])!
let mode = CommandLine.arguments[2]
let expectedIP = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : ""
let app = AXUIElementCreateApplication(pid)
func attr(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &result) == .success else { return nil }
    return result
}
_ = AXUIElementSetAttributeValue(app,"AXEnhancedUserInterface" as CFString,kCFBooleanTrue)
Thread.sleep(forTimeInterval:0.4)
let windows = attr(app,kAXWindowsAttribute) as? [AXUIElement] ?? []
var ipMatches = false, proxyError = false, loginVisible = false, challengeVisible = false
var emailFieldVisible = false, secureFieldVisible = false
var pageHosts = Set<String>()
var nodes = 0
func scan(_ element: AXUIElement, _ depth: Int) {
    guard depth < 35 && nodes < 4000 else { return }; nodes += 1
    let role = attr(element,kAXRoleAttribute) as? String ?? ""
    if role == "AXWebArea", let raw = attr(element,"AXURL") as? String, let host = URL(string:raw)?.host { pageHosts.insert(host) }
    if role == "AXSecureTextField" { secureFieldVisible = true }
    if role == "AXTextField" {
        let label=(attr(element,kAXDescriptionAttribute) as? String ?? "").lowercased()
        if label.contains("email") || label.contains("邮箱") { emailFieldVisible = true }
    }
    if ["AXStaticText","AXButton","AXHeading"].contains(role) || mode == "probe" && role == "AXTextArea" {
        let title = attr(element,kAXTitleAttribute) as? String ?? ""
        let value = role == "AXStaticText" || mode == "probe" && role == "AXTextArea" ? attr(element,kAXValueAttribute) as? String ?? "" : ""
        let description = attr(element,kAXDescriptionAttribute) as? String ?? ""
        let text = (title+" "+value+" "+description).lowercased()
        if mode == "probe" && !expectedIP.isEmpty && text.contains(expectedIP) { ipMatches = true }
        if text.contains("err_proxy_connection_failed") || text.contains("err_socks_connection_failed") { proxyError = true }
        if text.contains("使用 google 继续") || text.contains("continue with google") || text.contains("使用 apple 继续") { loginVisible = true }
        if text.contains("cloudflare") || text.contains("verify you are human") || text.contains("正在进行安全认证") { challengeVisible = true }
    }
    for child in attr(element,kAXChildrenAttribute) as? [AXUIElement] ?? [] { scan(child,depth+1) }
}
for window in windows {
    let title = attr(window,kAXTitleAttribute) as? String ?? ""
    let probeWindow = title.contains("ipify.org") || title.contains("1.1.1.1")
    if mode == "close-probes" && probeWindow || mode == "close-ip-probes" && title.contains("ipify.org") {
        if let button = attr(window,kAXCloseButtonAttribute) { _ = AXUIElementPerformAction(button as! AXUIElement,kAXPressAction as CFString) }
    } else if !mode.hasPrefix("close-") && mode != "windows" {
        scan(window,0)
        if mode == "focus" {
            NSRunningApplication(processIdentifier:pid)?.activate(options:[])
            _ = AXUIElementPerformAction(window,kAXRaiseAction as CFString)
        }
    }
}
let result: [String:Any] = ["windowCount":windows.count,"ipMatches":ipMatches,"proxyError":proxyError,"loginVisible":loginVisible,"challengeVisible":challengeVisible,"emailFieldVisible":emailFieldVisible,"secureFieldVisible":secureFieldVisible,"pageHosts":pageHosts.sorted(),"nodesChecked":nodes,"formValuesRead":false]
print(String(data:try! JSONSerialization.data(withJSONObject:result),encoding:.utf8)!)
