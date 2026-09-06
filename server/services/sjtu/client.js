const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

/**
 * 创建一个带独立 cookie jar 的 http 客户端。
 * 每一次 jaccount 登录流程都应该用一个新的实例，
 * 保证不同用户/不同登录尝试之间的 session cookie 不会串。
 */
function createSjtuClient() {
  const jar = new CookieJar();
  const http = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      maxRedirects: 10,
      timeout: 15000,
      headers: DEFAULT_HEADERS,
      // jaccount 在跳转链路中可能返回非 2xx 的中间状态，交给上层自行判断
      validateStatus: () => true
    })
  );

  return { jar, http };
}

module.exports = { createSjtuClient };
