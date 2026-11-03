// Browser evidence adapter for the device-local SQLite KV API. No sync or Mac.
export default {
  getItemSync: (key) => localStorage.getItem(key),
  setItemSync: (key, value) => localStorage.setItem(key, value),
};
