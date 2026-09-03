declare module 'html-to-docx' {
  type DocumentOptions = {
    font?: string;
    fontSize?: number;
    margins?: {
      top?: number;
      right?: number;
      bottom?: number;
      left?: number;
    };
    orientation?: 'portrait' | 'landscape';
    [key: string]: unknown;
  };

  function HTMLtoDOCX(
    htmlString: string,
    headerHTMLString?: string | null,
    documentOptions?: DocumentOptions | null,
    footerHTMLString?: string | null
  ): Promise<Buffer | ArrayBuffer | Blob>;

  export = HTMLtoDOCX;
}
