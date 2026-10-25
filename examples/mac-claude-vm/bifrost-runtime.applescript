-- Local, ordinary-user login helper. Requires the user's macOS Automation
-- consent to control UTM. It exposes no network listener or remote commands.
use framework "Foundation"
use scripting additions

property machineId : "__VM_ID__"
property statusPath : "__STATUS_PATH__"
property initialStartPending : true

on writeStatus(payload)
    set content to current application's NSString's stringWithString:payload
    content's writeToFile:statusPath atomically:true encoding:(current application's NSUTF8StringEncoding) |error|:(missing value)
    set attrs to current application's NSDictionary's dictionaryWithObject:384 forKey:(current application's NSFilePosixPermissions)
    current application's NSFileManager's defaultManager()'s setAttributes:attrs ofItemAtPath:statusPath |error|:(missing value)
end writeStatus

on refreshMachine()
    local shouldStart, targetVM, currentState, serialAddress
    try
        set shouldStart to initialStartPending
        with timeout of 30 seconds
            tell application "UTM"
                set targetVM to virtual machine id "__VM_ID__"
                if shouldStart and status of targetVM is not started then start targetVM
                if status of targetVM is started then
                    set currentState to "started"
                    set serialAddress to address of serial port 2 of targetVM
                else
                    set currentState to "not_started"
                    set serialAddress to ""
                end if
            end tell
        end timeout
        if currentState is "started" then set initialStartPending to false
        my writeStatus("{\"ok\":true,\"vmId\":\"" & machineId & "\",\"state\":\"" & currentState & "\",\"tty\":\"" & serialAddress & "\"}")
    on error errorMessage number errorNumber
        my writeStatus("{\"ok\":false,\"vmId\":\"" & machineId & "\",\"errorCode\":" & errorNumber & "}")
    end try
end refreshMachine

on run
    set initialStartPending to true
    my refreshMachine()
end run

on reopen
    my refreshMachine()
end reopen

on idle
    my refreshMachine()
    return 10
end idle
