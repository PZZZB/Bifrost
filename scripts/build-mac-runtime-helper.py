#!/usr/bin/env python3
"""Build a reviewable UTM login helper; macOS grants Automation interactively."""
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys

os.umask(0o077)
try:
    config_path = Path(sys.argv[1]).resolve()
    config = json.loads(config_path.read_text())
    vm_id = config['vmId']
    if not re.fullmatch(r'[0-9A-F-]{36}', vm_id):
        raise ValueError()
    directory = config_path.parent
    status_path = directory / 'vm-runtime.json'
    # These replacements are AppleScript literals, never shell substitutions.
    if any(char in str(status_path) for char in ['"', '\\', '\n', '\r']):
        raise ValueError()
    template = Path(__file__).resolve().parents[1] / 'examples/mac-claude-vm/bifrost-runtime.applescript'
    source = template.read_text().replace('__VM_ID__', vm_id).replace('__STATUS_PATH__', str(status_path))
    source_path = directory / 'bifrost-runtime.applescript'
    source_path.write_text(source)
    app = directory / 'Bifrost Runtime.app'
    subprocess.run(['/usr/bin/osacompile', '-s', '-o', str(app), str(source_path)], check=True, capture_output=True)
    info_path = app / 'Contents/Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    info.update(CFBundleIdentifier='local.bifrost.runtime', CFBundleName='Bifrost Runtime', CFBundleDisplayName='Bifrost Runtime',
        LSUIElement=True, NSAppleEventsUsageDescription='启动并检查你指定的隔离 Claude 虚拟机，以便登录 Mac 后自动恢复 Bifrost。')
    info_path.write_bytes(plistlib.dumps(info))
    entitlements = directory / 'runtime-entitlements.plist'
    entitlements.write_bytes(plistlib.dumps({'com.apple.security.automation.apple-events': True}))
    subprocess.run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', '--entitlements', str(entitlements), str(app)], check=True, capture_output=True)
    print(json.dumps({'ok': True, 'app': str(app), 'requiresAutomationConsent': True}))
except Exception:
    print('Runtime helper build failed. Requires macOS and a private health config.', file=sys.stderr)
    sys.exit(1)
