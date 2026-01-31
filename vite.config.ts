import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';
import type { ViteDevServer } from 'vite';

// Dynamic import to avoid server-side issues
let initializeWebSocket: ((httpServer: any) => void) | null = null;

export default defineConfig({
	plugins: [
		// Custom plugin to initialize WebSocket
		{
			name: 'websocket-server',
			configureServer(server: ViteDevServer) {
				if (server.httpServer) {
					// Dynamically import the websocket module
					import('./src/lib/server/websocket.js').then((mod) => {
						initializeWebSocket = mod.initializeWebSocket;
						if (initializeWebSocket && server.httpServer) {
							initializeWebSocket(server.httpServer);
						}
					});
				}
			}
		},
		sveltekit(),
		VitePWA({
			registerType: 'autoUpdate',
			manifest: {
				name: 'Aarogya Health System',
				short_name: 'Aarogya',
				description: 'AI-powered healthcare for rural communities',
				theme_color: '#3b82f6',
				background_color: '#ffffff',
				display: 'standalone',
				orientation: 'portrait',
				scope: '/',
				start_url: '/',
				icons: [
					{
						src: '/favicon.svg',
						sizes: 'any',
						type: 'image/svg+xml',
						purpose: 'any maskable'
					}
				]
			},
			workbox: {
				globPatterns: ['**/*.{js,css,html,svg,png,jpg,webp,woff,woff2}'],
				runtimeCaching: [
					{
						urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
						handler: 'CacheFirst',
						options: {
							cacheName: 'google-fonts-cache',
							expiration: {
								maxEntries: 10,
								maxAgeSeconds: 60 * 60 * 24 * 365
							},
							cacheableResponse: {
								statuses: [0, 200]
							}
						}
					},
					{
						urlPattern: /\/api\/.*/i,
						handler: 'NetworkFirst',
						options: {
							cacheName: 'api-cache',
							expiration: {
								maxEntries: 50,
								maxAgeSeconds: 60 * 5
							},
							networkTimeoutSeconds: 10
						}
					}
				]
			},
			devOptions: {
				enabled: true,
				type: 'module'
			}
		})
	],
	test: {
		environment: 'node',
		include: ['src/**/*.{test,spec}.{js,ts}'],
		exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
	}
});
