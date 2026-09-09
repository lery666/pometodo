/** Native update contract owned by Codex. UI implementation belongs to GLM. */
export interface UpdateRelease {
  version: string;
  releaseNotes: string;
  publishedAt: string;
}

export interface UpdateCheck {
  currentVersion: string;
  channel: "standalone" | "store";
  available: boolean;
  release: UpdateRelease | null;
}

export interface UpdateProgress {
  stage: "downloading" | "ready" | "installing";
  downloadedBytes: number;
  totalBytes: number | null;
}

export interface UpdateServices {
  check(): Promise<UpdateCheck>;
  download(): Promise<void>;
  install(): Promise<void>;
  onProgress(listener: (progress: UpdateProgress) => void): Promise<() => void>;
}
