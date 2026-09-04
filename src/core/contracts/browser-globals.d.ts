declare global {
  interface Window {
    __RABBITHOLE_FROZEN_CLIENT__?: boolean;
    __rhFilmCamera?: any;
    __rhMarkdownRendererSentinel?: string;
    __rabbitholeTest?: any;
    mermaid?: any;
    DOMPurify?: any;
  }

  const __RABBITHOLE_DEFAULT_PROXY_URL__: string;
  const __RABBITHOLE_VERSION__: string;
  const __RABBITHOLE_COMMIT__: string;
}

export {};
