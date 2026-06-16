/** Core data shapes for the context pipeline (walk → chunk → store → retrieve). */

/** A chunk of a file produced by the chunker. */
export interface Chunk {
  /** 0-based index within the file. */
  index: number;
  text: string;
  /** 1-based inclusive line range, for citations. */
  startLine: number;
  endLine: number;
}

/** A chunk as loaded back from storage for retrieval. */
export interface StoredChunk {
  relativePath: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  text: string;
  /** Present only when the app was indexed with an embedding model. */
  embedding?: Float32Array;
}

/** A chunk selected as relevant context for a question, with its score. */
export interface RetrievedChunk {
  relativePath: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
}
