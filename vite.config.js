// vite.config.js
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index:    resolve(__dirname, 'index.html'),
        catalogue:resolve(__dirname, 'catalogue.html'),
        scholar:  resolve(__dirname, 'scholar.html'),
        book:     resolve(__dirname, 'book.html'),
      }
    }
  }
});
