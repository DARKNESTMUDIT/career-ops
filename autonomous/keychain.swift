import Foundation
import Security

// Secrets arrive on stdin, never as process arguments or in source/config files.
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let data = try JSONSerialization.jsonObject(with: input) as! [String: Any]
    let service = data["service"] as! String
    let account = data["account"] as! String
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                               kSecAttrService as String: service,
                               kSecAttrAccount as String: account]
    if data["operation"] as? String == "put" {
        let value = (data["value"] as! String).data(using: .utf8)!
        let changes = [kSecValueData as String: value]
        var status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            query[kSecValueData as String] = value
            query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(query as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NSError(domain: "Keychain", code: Int(status)) }
        print("{\"ok\":true}")
    } else {
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { print("null") }
        else {
            guard status == errSecSuccess, let value = result as? Data else { throw NSError(domain: "Keychain", code: Int(status)) }
            FileHandle.standardOutput.write(value)
        }
    }
} catch {
    // Never echo inputs or token data in diagnostics.
    FileHandle.standardError.write(Data("Keychain operation failed\n".utf8))
    exit(1)
}
