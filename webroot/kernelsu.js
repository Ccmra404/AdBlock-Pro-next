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
