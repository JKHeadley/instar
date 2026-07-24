import http from 'node:http';

/** Minimal in-process implementation of the pinned Vercel Blob REST protocol. */
export class FakeBlobServer {
  private readonly server: http.Server;
  private readonly objects = new Map<string, string>();
  private suffixCounter = 0;
  baseUrl = '';

  constructor() { this.server = http.createServer((req, res) => this.handle(req, res)); }
  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  async stop(): Promise<void> { await new Promise<void>((resolve) => this.server.close(() => resolve())); }
  count(prefix: string): number { return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).length; }
  seed(pathname: string, content: string): void { this.objects.set(pathname, content); }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', this.baseUrl);
      if (req.method === 'PUT') {
        const pathname = url.pathname.replace(/^\//, '');
        const stored = req.headers['x-add-random-suffix'] === '1'
          ? pathname.replace(/(\.json)?$/, `-s${this.suffixCounter++}$1`) : pathname;
        this.objects.set(stored, body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ url: `${this.baseUrl}/${stored}`, pathname: stored }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/delete') {
        const { urls } = JSON.parse(body) as { urls: string[] };
        for (const item of urls) this.objects.delete(new URL(item).pathname.replace(/^\//, ''));
        res.end('{}'); return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? 1000);
        const blobs = [...this.objects.entries()].filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)
          .map(([pathname, content]) => ({ url: `${this.baseUrl}/${pathname}`, pathname, size: content.length, uploadedAt: new Date().toISOString() }));
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ blobs, hasMore: false })); return;
      }
      if (req.method === 'GET') {
        const content = this.objects.get(url.pathname.replace(/^\//, ''));
        if (content === undefined) { res.statusCode = 404; res.end('not found'); return; }
        res.end(content); return;
      }
      res.statusCode = 405; res.end();
    });
  }
}
