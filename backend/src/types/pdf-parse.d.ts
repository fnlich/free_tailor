declare module 'pdf-parse' {
  interface PDFInfo {
    PDFFormatVersion?: string;
    IsAcroFormPresent?: boolean;
    IsXFAPresent?: boolean;
    Title?: string;
    Author?: string;
    Subject?: string;
    Keywords?: string;
    Creator?: string;
    Producer?: string;
    CreationDate?: string;
    ModDate?: string;
  }

  interface PDFMetadata {
    _metadata?: Record<string, unknown>;
  }

  interface PDFData {
    numpages: number;
    numrender: number;
    info: PDFInfo;
    metadata: PDFMetadata | null;
    text: string;
    version: string;
  }

  interface PDFParseOptions {
    pagerender?: (pageData: { pageIndex: number; getTextContent: () => Promise<unknown> }) => Promise<string>;
    max?: number;
    version?: string;
  }

  function pdf(dataBuffer: Buffer, options?: PDFParseOptions): Promise<PDFData>;
  
  export = pdf;
}
