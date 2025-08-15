export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = 'truepulse.netlify.app'; // your actual Netlify domain
    return fetch(url, request);
  }
}
