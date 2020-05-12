const FirefoxCookie = require('firefox-cookie')
const FFCookie = new FirefoxCookie()

FFCookie.getCookie('youtube.com').then((cookie) => console.log(cookie))
