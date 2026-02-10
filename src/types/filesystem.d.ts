export {};

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }

  interface HTMLInputElement {
    webkitdirectory?: boolean;
    directory?: boolean;
  }
}
