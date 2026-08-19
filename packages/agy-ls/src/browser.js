export class BrowserService {
  constructor({ transport, router }) {
    this.transport = transport;
    this.router = router;
  }

  async instance() {
    await this.router.ensure();
    return this.router.instances[0];
  }

  async listPages() {
    const response = await this.transport.unary(await this.instance(), 'ListPages', {});
    return response.pages || [];
  }

  async list() {
    return this.listPages();
  }

  async focus(pageId) {
    await this.transport.unary(await this.instance(), 'FocusUserPage', { pageId });
    return { ok: true };
  }

  async open(url, isOnboarded = true) {
    await this.transport.unary(await this.instance(), 'SmartOpenBrowser', { url, isOnboarded });
    return { ok: true };
  }

  async screenshot(pageId) {
    const response = await this.transport.unary(await this.instance(), 'CaptureScreenshot', { pageId });
    const data = response.data || response.image?.data || response.base64Data || response.bytes || '';
    const mimeType = response.mimeType || response.image?.mimeType || 'image/png';
    return { data, mimeType, raw: response };
  }

  async consoleLogs(pageId) {
    return this.transport.unary(await this.instance(), 'CaptureConsoleLogs', { pageId });
  }
}
