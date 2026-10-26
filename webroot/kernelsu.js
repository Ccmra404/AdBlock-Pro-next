// KernelSU-compatible bridge, also provided by APatch and compatible WebUI hosts.
let callbackCounter = 0;

export function exec(command, options = {}) {
  return new Promise((resolve, reject) => {
    if (!window.ksu || typeof window.ksu.exec !== 'function') {
      reject(new Error('Root WebUI 接口不可用。请从 KernelSU/APatch 或兼容的 WebUI 宿主打开；Magisk 用户需另用支持该接口的宿主。'));
      return;
    }
    const name = `ksu_exec_${Date.now()}_${callbackCounter++}`;
    window[name] = (errno, stdout, stderr) => {
      try { resolve({ errno, stdout, stderr }); }
      finally { delete window[name]; }
    };
    try {
      window.ksu.exec(command, JSON.stringify(options), name);
    } catch (error) {
      delete window[name];
      reject(error);
    }
  });
}

// Use the host's package catalogue; older hosts fall back to package names.
export async function listApplications() {
  const bridge = window.ksu;
  let packages;
  try {
    const raw = typeof bridge?.listPackages === 'function' ? bridge.listPackages('user')
      : typeof bridge?.listUserPackages === 'function' ? bridge.listUserPackages() : null;
    packages = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { packages = null; }
  if (!Array.isArray(packages)) {
    const result = await exec('pm list packages -3 --user 0');
    if (Number(result.errno)) throw new Error('无法读取本机应用，请检查 Root 权限');
    packages = String(result.stdout || '').split(/\r?\n/).map(x => x.replace(/^package:/, '').trim());
  }
  packages = [...new Set(packages)].filter(x => typeof x === 'string' && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(x));
  const apps = [];
  const missingLabels = new Set();
  for (let i = 0; i < packages.length; i += 40) {
    const batch = packages.slice(i, i + 40);
    let info = [];
    try {
      if (typeof bridge?.getPackagesInfo === 'function') {
        const raw = bridge.getPackagesInfo(JSON.stringify(batch));
        info = typeof raw === 'string' ? JSON.parse(raw) : raw;
      }
    } catch { info = []; }
    for (const packageName of batch) {
      const item = Array.isArray(info) && info.find(x => x?.packageName === packageName && !x.error);
      const label = typeof item?.appLabel === 'string' && item.appLabel.trim() ? item.appLabel : '';
      if (!label) missingLabels.add(packageName);
      apps.push({ packageName, label: (label || packageName).slice(0, 255) });
    }
    if (i + 40 < packages.length) await new Promise(resolve => setTimeout(resolve, 0));
  }
  // Standalone Magisk hosts may expose exec() without any package-label API.
  // Read labels locally once; a missing/failed helper keeps package search usable.
  if (missingLabels.size) {
    try {
      const result = await exec('sh /data/adb/modules/bindhosts_personal/webui-config.sh application-labels');
      const info = Number(result.errno) === 0 ? JSON.parse(result.stdout) : null;
      if (Array.isArray(info)) {
        const labels = new Map(info.filter(x => x && missingLabels.has(x.packageName) && typeof x.appLabel === 'string' && x.appLabel.trim()).map(x => [x.packageName, x.appLabel.slice(0, 255)]));
        for (const app of apps) if (labels.has(app.packageName)) app.label = labels.get(app.packageName);
      }
    } catch { /* Package names remain available when Android cannot load labels. */ }
  }
  return apps.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}
