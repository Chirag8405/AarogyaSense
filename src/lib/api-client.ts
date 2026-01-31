/**
 * API Client for Aarogya Health System
 * Handles authentication, requests, and error handling
 */

import { browser } from '$app/environment';

const API_BASE = browser ? window.location.origin : 'http://localhost:5173';

export class APIError extends Error {
	constructor(
		message: string,
		public status: number,
		public data?: any
	) {
		super(message);
		this.name = 'APIError';
	}
}

class APIClient {
	private token: string | null = null;

	constructor() {
		// Load token from localStorage on initialization
		if (browser) {
			this.token = localStorage.getItem('auth_token');
		}
	}

	/**
	 * Set authentication token
	 */
	setToken(token: string): void {
		this.token = token;
		if (browser) {
			localStorage.setItem('auth_token', token);
		}
	}

	/**
	 * Clear authentication token
	 */
	clearToken(): void {
		this.token = null;
		if (browser) {
			localStorage.removeItem('auth_token');
			localStorage.removeItem('user');
		}
	}

	/**
	 * Get stored user info
	 */
	getUser(): any | null {
		if (!browser) return null;
		const userStr = localStorage.getItem('user');
		return userStr ? JSON.parse(userStr) : null;
	}

	/**
	 * Store user info
	 */
	setUser(user: any): void {
		if (browser) {
			localStorage.setItem('user', JSON.stringify(user));
		}
	}

	/**
	 * Make authenticated API request with Offline Support
	 */
	private async request<T>(
		endpoint: string,
		options: RequestInit = {}
	): Promise<T> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			...(options.headers as Record<string, string>)
		};

		// Add auth token if available
		if (this.token) {
			headers['Authorization'] = `Bearer ${this.token}`;
		}

		const url = `${API_BASE}${endpoint}`;
		
		try {
			// Check for internet connection first
			if (!navigator.onLine && options.method !== 'GET') {
				throw new Error('OFFLINE');
			}

			const response = await fetch(url, {
				...options,
				headers
			});

			// Handle non-OK responses
			if (!response.ok) {
				const error = await response.json().catch(() => ({ error: response.statusText }));
				throw new APIError(
					error.error || 'Request failed',
					response.status,
					error
				);
			}

			return response.json();
		} catch (error: any) {
			// Offline Handling
			if (error.message === 'OFFLINE' || error.message === 'Failed to fetch' || error.message === 'Network error') {
				if (options.method === 'POST' && endpoint.includes('/cases')) {
					console.log('Offline: Queuing request for later sync');
					this.queueRequest(endpoint, options);
					// Return a mock success response for offline save
					return { 
						id: 'OFFLINE_' + Date.now(), 
						status: 'PENDING_SYNC',
						offline: true 
					} as any;
				}
			}

			if (error instanceof APIError) {
				throw error;
			}
			throw new APIError(
				error instanceof Error ? error.message : 'Network error',
				0
			);
		}
	}

	/**
	 * Queue failed requests for later sync
	 */
	private queueRequest(endpoint: string, options: any) {
		if (!browser) return;
		
		const queue = JSON.parse(localStorage.getItem('offline_queue') || '[]');
		queue.push({
			id: Date.now(),
			endpoint,
			options,
			timestamp: Date.now()
		});
		localStorage.setItem('offline_queue', JSON.stringify(queue));
	}

	/**
	 * Sync queued requests
	 */
	async syncOfflineData(): Promise<number> {
		if (!browser || !navigator.onLine) return 0;

		const queue = JSON.parse(localStorage.getItem('offline_queue') || '[]');
		if (queue.length === 0) return 0;

		console.log(`Syncing ${queue.length} offline items...`);
		const failedItems = [];
		let syncedCount = 0;

		for (const item of queue) {
			try {
				await this.request(item.endpoint, item.options);
				syncedCount++;
			} catch (error) {
				console.error('Sync failed for item:', item.id, error);
				failedItems.push(item);
			}
		}

		localStorage.setItem('offline_queue', JSON.stringify(failedItems));
		return syncedCount;
	}


	/**
	 * Authentication endpoints
	 */
	auth = {
		register: async (data: {
			email: string;
			password: string;
			name: string;
			role: string;
			phone?: string;
			language?: string;
		}) => {
			const response = await this.request<{ user: any; token: string }>(
				'/api/auth/register',
				{
					method: 'POST',
					body: JSON.stringify(data)
				}
			);
			this.setToken(response.token);
			this.setUser(response.user);
			return response;
		},

		login: async (email: string, password: string) => {
			const response = await this.request<{ user: any; token: string }>(
				'/api/auth/login',
				{
					method: 'POST',
					body: JSON.stringify({ email, password })
				}
			);
			this.setToken(response.token);
			this.setUser(response.user);
			return response;
		},

		logout: () => {
			this.clearToken();
		}
	};

	/**
	 * Cases endpoints
	 */
	cases = {
		list: async (params?: {
			status?: string;
			userId?: string;
			limit?: number;
			offset?: number;
		}) => {
			const query = new URLSearchParams(params as any).toString();
			return this.request<{ cases: any[]; pagination: any }>(
				`/api/cases${query ? `?${query}` : ''}`
			);
		},

		create: async (data: {
			patient: any;
			symptoms: string;
			vitalSigns?: any;
			images?: string[];
			audioRecordings?: string[];
			notes?: string;
			location?: string;
		}) => {
			return this.request<any>('/api/cases', {
				method: 'POST',
				body: JSON.stringify(data)
			});
		},

		get: async (id: string) => {
			return this.request<any>(`/api/cases/${id}`);
		},

		update: async (id: string, data: any) => {
			return this.request<any>(`/api/cases/${id}`, {
				method: 'PATCH',
				body: JSON.stringify(data)
			});
		}
	};

	/**
	 * Alerts endpoints
	 */
	alerts = {
		list: async (params?: {
			caseId?: string;
			userId?: string;
			status?: string;
			level?: string;
			limit?: number;
		}) => {
			const query = new URLSearchParams(params as any).toString();
			return this.request<{ alerts: any[] }>(
				`/api/alerts${query ? `?${query}` : ''}`
			);
		},

		create: async (data: {
			caseId: string;
			recipientId: string;
			level: string;
			message: string;
			channels?: string[];
		}) => {
			return this.request<{ alert: any; delivery: any }>(
				'/api/alerts',
				{
					method: 'POST',
					body: JSON.stringify(data)
				}
			);
		},

		markRead: async (alertId: string) => {
			return this.request<{ alert: any }>(
				`/api/alerts/${alertId}/read`,
				{
					method: 'PUT'
				}
			);
		}
	};

	/**
	 * CHW endpoints
	 */
	chw = {
		list: async (params?: {
			active?: boolean;
			location?: string;
		}) => {
			const query = new URLSearchParams(params as any).toString();
			return this.request<{ chws: any[]; total: number }>(
				`/api/chw${query ? `?${query}` : ''}`
			);
		}
	};

	/**
	 * Case review endpoints
	 */
	review = {
		approve: async (caseId: string, notes?: string) => {
			return this.request<{ case: any; message: string }>(
				`/api/cases/${caseId}/review`,
				{
					method: 'PUT',
					body: JSON.stringify({
						action: 'approve',
						notes
					})
				}
			);
		},

		reject: async (caseId: string, notes?: string) => {
			return this.request<{ case: any; message: string }>(
				`/api/cases/${caseId}/review`,
				{
					method: 'PUT',
					body: JSON.stringify({
						action: 'reject',
						notes
					})
				}
			);
		},

		escalate: async (caseId: string, priority?: number, notes?: string) => {
			return this.request<{ case: any; message: string }>(
				`/api/cases/${caseId}/review`,
				{
					method: 'PUT',
					body: JSON.stringify({
						action: 'escalate',
						priority,
						notes
					})
				}
			);
		}
	};

	/**
	 * Analytics endpoints
	 */
	analytics = {
		chwPerformance: async (params?: {
			chwId?: string;
			days?: number;
		}) => {
			const query = new URLSearchParams(params as any).toString();
			return this.request<{
				summary: any;
				byCHW: any[];
				volumeTrend: any[];
				dateRange: any;
			}>(`/api/analytics/chw-performance${query ? `?${query}` : ''}`);
		},

		clinicianPerformance: async (params?: {
			clinicianId?: string;
			days?: number;
		}) => {
			const query = new URLSearchParams(params as any).toString();
			return this.request<{
				summary: any;
				byClinician: any[];
				dailyTrend: any[];
				criticalCases: any[];
				dateRange: any;
			}>(`/api/analytics/clinician-performance${query ? `?${query}` : ''}`);
		}
	};

	/**
	 * Clinician endpoints
	 */
	clinician = {
		getCases: async (params?: {
			status?: string;
			priorityMin?: number;
			limit?: number;
		}) => {
			const query = new URLSearchParams(params as any).toString();
			return this.request<{
				cases: any[];
				stats: any;
				total: number;
			}>(`/api/clinician/cases${query ? `?${query}` : ''}`);
		},

		reviewCase: async (caseId: string, data: {
			action: 'accept' | 'refer' | 'prescribe';
			diagnosis?: {
				condition?: string;
				confidence?: number;
				riskScore?: number;
				urgency?: string;
				recommendations?: string;
			};
			prescription?: string;
			notes?: string;
			followUpDate?: string;
			clinicianId?: string;
			referralReason?: string;
		}) => {
			return this.request<{
				case: any;
				diagnosis: any;
				alert: any;
				message: string;
			}>(`/api/cases/${caseId}/clinician-review`, {
				method: 'PUT',
				body: JSON.stringify(data)
			});
		}
	};

	/**
	 * Users endpoints
	 */
	users = {
		list: async (params?: { role?: string; location?: string }) => {
			const query = new URLSearchParams(params as any).toString();
			return this.request<{ users: any[] }>(
				`/api/users${query ? `?${query}` : ''}`
			);
		}
	};
}

// Export singleton instance
export const apiClient = new APIClient();

export default apiClient;
