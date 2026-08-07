import xbmc
import xbmcgui
import xbmcaddon
import subprocess
import threading
import time
import socket
import os
import json

ADDON = xbmcaddon.Addon()
ADDON_ID = ADDON.getAddonInfo('id')
ADDON_NAME = ADDON.getAddonInfo('name')
ADDON_PATH = ADDON.getAddonInfo('path')
STRINGS = ADDON.getLocalizedString

class SnapcastClient:
    def __init__(self):
        self.process = None
        self.is_running = False
        self.server_ip = ADDON.getSetting('server_ip')
        self.server_port = ADDON.getSetting('server_port')
        self.client_name = ADDON.getSetting('client_name')
        self.latency = ADDON.getSetting('latency')
        self.use_pulse = ADDON.getSetting('use_pulse') == 'true'
        
    def get_snapclient_path(self):
        paths = [
            '/data/data/com.termux/files/usr/bin/snapclient',
            '/usr/bin/snapclient',
            '/usr/local/bin/snapclient',
            '/opt/homebrew/bin/snapclient',
        ]
        for path in paths:
            if os.path.exists(path):
                return path
        return 'snapclient'
    
    def start(self):
        if self.is_running:
            return True
        
        if not self.server_ip:
            self.show_dialog(3001)
            ADDON.openSettings()
            return False
        
        cmd = [self.get_snapclient_path(), '-h', self.server_ip]
        
        if self.server_port:
            cmd.extend(['-p', self.server_port])
        
        if self.client_name:
            cmd.extend(['-n', self.client_name])
        
        if self.latency:
            cmd.extend(['--latency', self.latency])
        
        if self.use_pulse:
            cmd.extend(['--player', 'pulse'])
        
        xbmc.log(f"[Snapcast] Starting client: {' '.join(cmd)}", xbmc.LOGINFO)
        
        try:
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                preexec_fn=os.setsid
            )
            self.is_running = True
            threading.Thread(target=self.monitor_process, daemon=True).start()
            xbmc.log(f"[Snapcast] Client started with PID: {self.process.pid}", xbmc.LOGINFO)
            self.show_notification(3002)
            return True
        except Exception as e:
            xbmc.log(f"[Snapcast] Failed to start client: {str(e)}", xbmc.LOGERROR)
            self.show_dialog(3003, str(e))
            return False
    
    def stop(self):
        if not self.is_running or not self.process:
            return
        
        try:
            os.killpg(os.getpgid(self.process.pid), 9)
            self.process.wait(timeout=5)
        except:
            pass
        
        self.is_running = False
        self.process = None
        xbmc.log("[Snapcast] Client stopped", xbmc.LOGINFO)
        self.show_notification(3004)
    
    def monitor_process(self):
        while self.is_running:
            if self.process.poll() is not None:
                stdout, stderr = self.process.communicate()
                xbmc.log(f"[Snapcast] Client exited with code: {self.process.returncode}", xbmc.LOGWARNING)
                if stderr:
                    xbmc.log(f"[Snapcast] Client error: {stderr.decode()}", xbmc.LOGERROR)
                self.is_running = False
                if self.process.returncode != 0:
                    self.show_notification(3005)
                break
            time.sleep(1)
    
    def is_connected(self):
        if not self.server_ip:
            return False
        
        try:
            port = int(self.server_port) if self.server_port else 1704
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(2)
            result = sock.connect_ex((self.server_ip, port))
            sock.close()
            return result == 0
        except:
            return False
    
    def get_status(self):
        if self.is_running:
            return STRINGS(3006)
        elif self.is_connected():
            return STRINGS(3007)
        else:
            return STRINGS(3008)
    
    def show_notification(self, string_id):
        xbmcgui.Dialog().notification(
            ADDON_NAME,
            STRINGS(string_id),
            ADDON.getAddonInfo('icon'),
            3000
        )
    
    def show_dialog(self, string_id, details=''):
        message = STRINGS(string_id)
        if details:
            message += f"\n\n{details}"
        xbmcgui.Dialog().ok(ADDON_NAME, message)

class SnapcastMenu(xbmcgui.WindowXMLDialog):
    def __init__(self, *args, **kwargs):
        self.client = kwargs.get('client')
        super(SnapcastMenu, self).__init__(*args, **kwargs)
    
    def onInit(self):
        self.update_status()
    
    def update_status(self):
        status_label = self.getControl(101)
        if status_label:
            status_label.setLabel(self.client.get_status())
        
        server_label = self.getControl(102)
        if server_label:
            server_label.setLabel(f"{STRINGS(3009)}: {self.client.server_ip}")
        
        name_label = self.getControl(103)
        if name_label:
            name_label.setLabel(f"{STRINGS(3010)}: {self.client.client_name or STRINGS(3011)}")
    
    def onAction(self, action):
        if action.getId() in [92, 10]:
            self.close()
    
    def onClick(self, controlId):
        if controlId == 201:
            self.start_client()
        elif controlId == 202:
            self.stop_client()
        elif controlId == 203:
            self.toggle_client()
        elif controlId == 204:
            ADDON.openSettings()
            self.client = SnapcastClient()
            self.update_status()
        elif controlId == 205:
            self.close()
    
    def start_client(self):
        if self.client.start():
            self.update_status()
    
    def stop_client(self):
        self.client.stop()
        self.update_status()
    
    def toggle_client(self):
        if self.client.is_running:
            self.stop_client()
        else:
            self.start_client()

class SnapcastService(xbmc.Monitor):
    def __init__(self):
        super(SnapcastService, self).__init__()
        self.client = SnapcastClient()
        
        if ADDON.getSetting('auto_start') == 'true':
            xbmc.log("[Snapcast] Auto-start enabled, waiting 10s before starting", xbmc.LOGINFO)
            threading.Timer(10, self.delayed_start).start()
    
    def delayed_start(self):
        if not self.client.is_running:
            self.client.start()
    
    def onSettingsChanged(self):
        xbmc.log("[Snapcast] Settings changed, restarting client", xbmc.LOGINFO)
        self.client.stop()
        self.client = SnapcastClient()
        if ADDON.getSetting('auto_start') == 'true':
            threading.Timer(2, self.delayed_start).start()
    
    def onNotification(self, sender, method, data):
        pass

def run():
    mode = ADDON.getSetting('run_mode')
    
    if mode == 'service':
        xbmc.log("[Snapcast] Running as service", xbmc.LOGINFO)
        service = SnapcastService()
        while not service.abortRequested():
            if service.waitForAbort(1):
                break
        service.client.stop()
    else:
        xbmc.log("[Snapcast] Running as script", xbmc.LOGINFO)
        client = SnapcastClient()
        
        if not client.server_ip:
            client.show_dialog(3001)
            ADDON.openSettings()
            client = SnapcastClient()
        
        dialog = SnapcastMenu(
            "script-snapcast-main.xml",
            ADDON_PATH,
            "default",
            client=client
        )
        dialog.doModal()
        del dialog

if __name__ == '__main__':
    run()
