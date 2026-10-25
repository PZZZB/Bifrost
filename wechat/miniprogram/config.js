// Public deployment settings only. AppSecret and administrator keys belong on Mac.
module.exports = {
  transport: 'cloud',
  cloudEnv: '',
  cloudFunction: 'bifrost-account',
  // Direct wx.request mode requires a configured, ICP-filed HTTPS server domain.
  requestOrigin: '',
};
