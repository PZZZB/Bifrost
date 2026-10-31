#!/usr/bin/env python3
"""Ordinary Chrome + fixed VPS proxy. No CDP or automated website interaction."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import parse_qs, urlsplit
import uuid
from datetime import datetime, timezone

ROOT = Path.home() / 'Library/Application Support/ClaudeVPS'
BASE = ROOT / 'Bifrost/ClaudeLogin/ManualBrowser'
BRIDGE = Path(__file__).with_name('claude-vm-login-bridge.py')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
ENV = {k:v for k,v in os.environ.items() if k in {'PATH','HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL','__CF_USER_TEXT_ENCODING'}}
proxy = browser = None
profile = None
owns_lock = False
state = {'phase':'starting','pid':os.getpid(),'debuggingEnabled':False}


def save(name, value):
    path = BASE / name
    tmp = path.with_suffix('.tmp')
    fd = os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f: f.write(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
    tmp.replace(path)


def publish(phase, **fields):
    state.update(fields,phase=phase,updatedAt=time.time())
    save('state.json',state)


def bridge(action, value=None):
    r = subprocess.run([sys.executable,str(BRIDGE),action],input=json.dumps(value) if value is not None else None,
                       capture_output=True,text=True,env=ENV,timeout=30)
    if r.returncode: raise RuntimeError('vm_login_transport_failed')
    return json.loads(r.stdout)


def proxy_start():
    global proxy
    if proxy and proxy.poll() is None: return
    with socket.socket() as s:
        s.settimeout(.2)
        if s.connect_ex(('127.0.0.1',17894))==0: raise RuntimeError('proxy_port_in_use')
    proxy = subprocess.Popen([str(ROOT/'bin/mihomo'),'-d',str(BASE/'proxy-state'),'-f',str(BASE/'proxy.json')],
                             stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=ENV)
    for _ in range(50):
        try:
            with socket.create_connection(('127.0.0.1',17894),timeout=.2): break
        except OSError:
            if proxy.poll() is not None: raise RuntimeError('proxy_start_failed')
            time.sleep(.1)
    else: raise RuntimeError('proxy_start_timeout')
    state['proxyPid'] = proxy.pid


def stop(child):
    if child and child.poll() is None:
        child.terminate()
        try: child.wait(timeout=3)
        except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=3)


def args(url):
    return [CHROME,'--user-data-dir='+str(profile),'--incognito','--new-window','--no-first-run','--no-default-browser-check',
            '--disable-sync','--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-quic',
            '--proxy-server=socks5://127.0.0.1:17894','--proxy-bypass-list=<-loopback>',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',url]


def open_url(url):
    subprocess.run(args(url),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=ENV,timeout=10,check=True)


def validate_authorization_url(value):
    if not isinstance(value,str) or len(value)>8192: raise ValueError()
    u=urlsplit(value);q=parse_qs(u.query,keep_blank_values=True)
    if (u.scheme!='https' or u.hostname not in {'claude.ai','claude.com','platform.claude.com','console.anthropic.com'}
            or u.username or u.password or u.port or u.fragment or 'oauth' not in u.path
            or any(len(q.get(k,[]))!=1 or not q[k][0] for k in ['state','code_challenge','redirect_uri'])):
        raise ValueError()
    redirect=urlsplit(q['redirect_uri'][0])
    if (redirect.scheme!='https' or redirect.hostname not in {'platform.claude.com','console.anthropic.com','claude.ai','claude.com'}
            or redirect.path!='/oauth/code/callback' or redirect.username or redirect.password or redirect.port or redirect.fragment or redirect.query):
        raise ValueError()
    return q['state'][0]


def audit(mode='probe'):
    expected=json.loads((ROOT/'Bifrost/Maintenance/health.json').read_text())['expectedExitIp']
    r=subprocess.run(['/usr/bin/swift',str(Path(__file__).with_name('mac-login-window.swift')),str(browser.pid),mode,expected],
                     capture_output=True,text=True,timeout=20,env=ENV,check=True)
    return json.loads(r.stdout)


def require_probe(flag):
    deadline=time.monotonic()+75
    while time.monotonic()<deadline:
        if audit().get(flag) is True: return
        time.sleep(.3)
    raise RuntimeError('ordinary_browser_network_check_failed')


def network_preflight():
    require_probe('ipMatches')
    stop(proxy)
    open_url('https://1.1.1.1/cdn-cgi/trace?probe='+uuid.uuid4().hex)
    require_probe('proxyError')
    audit('close-ip-probes')
    proxy_start()
    open_url('https://api.ipify.org?format=json&probe='+uuid.uuid4().hex)
    require_probe('ipMatches')
    save('network-precheck.json',{'checkedAt':datetime.now(timezone.utc).isoformat(),'chromePid':browser.pid,
         'actualOrdinaryChromeExitVerified':True,'proxyStoppedRequestFailed':True,'proxyRestoredSameExit':True,'cdpEnabled':False})


def begin_authorization():
    current = bridge('start')
    state['vmSessionPid'] = current.get('pid')
    for _ in range(120):
        result = bridge('get-url')
        if result.get('phase') in {'authenticated','already_authenticated'}:
            publish('authenticated'); return
        if result.get('url'):
            state['oauthState'] = validate_authorization_url(result['url'])
            open_url(result['url'])
            publish('waiting_for_owner_login',cliAuthenticated=False); return
        time.sleep(.5)
    raise RuntimeError('vm_authorization_not_ready')


def receive_code():
    if not state.get('oauthState'): raise RuntimeError('authorization_not_started')
    publish('awaiting_owner_authorization_code')
    script = 'set r to display dialog "请把 Claude 官方授权完成页显示的一次性授权码粘贴到这里。它将直接送入虚拟机，请不要发到聊天里。" default answer "" with hidden answer with title "Claude：完成虚拟机登录" buttons {"取消", "完成登录"} default button "完成登录"\nreturn text returned of r'
    r = subprocess.run(['/usr/bin/osascript','-e',script],capture_output=True,text=True,timeout=900)
    if r.returncode: publish('waiting_for_owner_login'); return
    code = r.stdout.strip()
    if not 1<=len(code)<=2048 or any(ord(c)<=32 or ord(c)==127 for c in code): raise RuntimeError('invalid_authorization_code')
    bridge('send',{'action':'code','state':state['oauthState'],'value':code})
    publish('finishing_vm_login')


def main():
    global browser,profile,owns_lock
    import shutil
    BASE.mkdir(mode=0o700,parents=True,exist_ok=True); BASE.chmod(0o700)
    lock = BASE/'keeper.lock'
    if lock.exists():
        prior = json.loads(lock.read_text())
        try: os.kill(prior['pid'],0)
        except ProcessLookupError: lock.unlink()
        else: raise RuntimeError('manual_login_browser_already_running')
    fd=os.open(lock,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f: f.write(json.dumps({'pid':os.getpid()}))
    owns_lock=True
    (BASE/'control.json').unlink(missing_ok=True)
    cfg=json.loads((ROOT/'config/host-mihomo.json').read_text())
    cfg.update({'mixed-port':17894,'bind-address':'127.0.0.1','allow-lan':False,'lan-allowed-ips':['127.0.0.1/32'],
                'lan-disallowed-ips':[],'authentication':[],'skip-auth-prefixes':[],'ipv6':False,'tun':{'enable':False},'log-level':'silent'})
    cfg.pop('external-controller',None);cfg.pop('external-controller-unix',None)
    if any('DIRECT' in rule for rule in cfg['rules']): raise RuntimeError('unsafe_proxy_rules')
    save('proxy.json',cfg);(BASE/'proxy-state').mkdir(mode=0o700,exist_ok=True)
    proxy_start()
    profile=BASE/('profile-'+uuid.uuid4().hex);profile.mkdir(mode=0o700);(profile/'Default').mkdir(mode=0o700)
    state['profileDirectory']=str(profile)
    save_preferences=profile/'Default/Preferences'
    fd=os.open(save_preferences,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f: f.write(json.dumps({'credentials_enable_service':False,'profile':{'password_manager_enabled':False}}))
    browser=subprocess.Popen(args('https://api.ipify.org?format=json&probe='+uuid.uuid4().hex),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=ENV)
    publish('network_preflight',chromePid=browser.pid,proxyPid=proxy.pid)
    network_preflight()
    begin_authorization()
    deadline=time.monotonic()+7200;last_control=None;last_probe=0;last_window_probe=0
    while time.monotonic()<deadline and browser.poll() is None:
        control=BASE/'control.json'
        if control.exists():
            command=json.loads(control.read_text())
            if command.get('id')!=last_control:
                last_control=command.get('id'); action=command.get('action')
                if action=='proxy_stop': stop(proxy);publish('proxy_stopped_for_network_test')
                elif action=='proxy_start': proxy_start();publish('network_preflight')
                elif action=='begin_authorization': begin_authorization()
                elif action=='receive_code': receive_code()
                elif action=='close': break
                else: raise RuntimeError('unknown_browser_control')
                state['lastControlId']=last_control;publish(state['phase'])
        if state.get('oauthState') and time.monotonic()-last_probe>5:
            last_probe=time.monotonic(); current=bridge('status')
            if current.get('phase') in {'authenticated','already_authenticated'}:
                publish('authenticated',cliAuthenticated=True);break
            if current.get('phase') in {'not_authenticated','failed','cancelled'}:
                publish('cli_authorization_expired_browser_retained',cliAuthenticated=False)
        if time.monotonic()-last_window_probe>10:
            last_window_probe=time.monotonic()
            if audit('windows').get('windowCount')==0: break
        time.sleep(.25)
    if state['phase']!='authenticated': publish('closed_without_verified_login')


def terminate(*_): raise KeyboardInterrupt()
if __name__=='__main__':
    if len(sys.argv)>1:
        if len(sys.argv)!=2: raise SystemExit('Pass an action only; never put authorization codes in arguments.')
        action=sys.argv[1]
        if action=='status':
            d=json.loads((BASE/'state.json').read_text())
            print(json.dumps({k:d[k] for k in ['phase','updatedAt','cliAuthenticated','debuggingEnabled','chromePid'] if k in d}))
        elif action in {'authorize','code','close'}:
            save('control.json',{'id':uuid.uuid4().hex,'action':{'authorize':'begin_authorization','code':'receive_code','close':'close'}[action]})
            print(json.dumps({'requested':True,'action':action}))
        else: raise SystemExit('Unknown manual login action.')
        raise SystemExit(0)
    signal.signal(signal.SIGTERM,terminate)
    signal.signal(signal.SIGINT,terminate)
    try:
        main()
    except KeyboardInterrupt:
        if owns_lock: publish('closed_by_owner')
    except Exception as error:
        if owns_lock: publish('failed',error='manual_login_preparation_failed',errorType=type(error).__name__)
        raise SystemExit(1)
    finally:
        import shutil
        stop(browser);stop(proxy)
        if profile: shutil.rmtree(profile,ignore_errors=True)
        if owns_lock:
            (BASE/'proxy.json').unlink(missing_ok=True)
            (BASE/'keeper.lock').unlink(missing_ok=True)
