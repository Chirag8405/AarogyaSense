<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { authStore } from '$lib/stores/auth-store';
	import { apiClient } from '$lib/api-client';
	import { analyzeImage, loadImage } from '$lib/ai/image-analyzer';
	import { analyzeAudio, recordAudio } from '$lib/ai/voice-analyzer';
	import { calculateRiskScore } from '$lib/ai/risk-scorer';
	import type { RiskAssessment } from '$lib/ai/risk-scorer';
	import NotificationCenter from '$lib/components/NotificationCenter.svelte';
	import { get } from 'svelte/store';

	let unauthorized = false;

	// Auth check and load cases
	onMount(() => {
		// Sync offline data when coming online
		window.addEventListener('online', async () => {
			const count = await apiClient.syncOfflineData();
			if (count > 0) {
				alert(`Synced ${count} offline cases!`);
				loadMyCases();
			}
		});

		// Simple one-time auth check using get()
		const state = get(authStore);
		if (!state.isAuthenticated) {
			goto('/auth', { replaceState: true });
			return;
		}
		
		// Check if user has permission to access CHW portal
		const allowedRoles = ['CHW', 'ASHA', 'ASHA_SUPERVISOR', 'CLINICIAN', 'DOCTOR', 'ADMIN'];
		if (!allowedRoles.includes(state.user?.role || '')) {
			unauthorized = true;
			return;
		}
		
		loadMyCases();
		loadAshas();
	});

	// Tab State
	let activeTab: 'new-case' | 'case-history' = 'new-case';

	// Notifications
	let showNotifications = false;

	// Case History
	let myCases: any[] = [];
	let isLoadingCases = false;
	let selectedCaseDetails: any = null;
	let showCaseModal = false;

	async function loadMyCases() {
		if (!$authStore.user?.id) return;
		
		try {
			isLoadingCases = true;
			const response = await apiClient.cases.list({
				userId: $authStore.user.id,
				limit: 100
			});
			myCases = response.cases.sort((a: any, b: any) => 
				new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
			);
		} catch (error) {
			console.error('Failed to load cases:', error);
		} finally {
			isLoadingCases = false;
		}
	}

	// ASHA Workers
	let ashaWorkers: any[] = [];
	let selectedAshaId = '';

	async function loadAshas() {
		try {
			const response = await apiClient.users.list({ role: 'ASHA' });
			ashaWorkers = response.users;
			// Auto-select first ASHA if available
			if (ashaWorkers.length > 0) {
				selectedAshaId = ashaWorkers[0].id;
			}
		} catch (error) {
			console.error('Failed to load ASHA workers:', error);
		}
	}

	function viewCaseDetails(caseItem: any) {
		selectedCaseDetails = caseItem;
		showCaseModal = true;
	}

	function closeCaseModal() {
		showCaseModal = false;
		selectedCaseDetails = null;
	}

	function getStatusBadgeClass(status: string): string {
		const classes: Record<string, string> = {
			'PENDING': 'bg-yellow-100 text-yellow-800 border-yellow-200',
			'APPROVED': 'bg-green-100 text-green-800 border-green-200',
			'REJECTED': 'bg-red-100 text-red-800 border-red-200',
			'UNDER_REVIEW': 'bg-blue-100 text-blue-800 border-blue-200'
		};
		return classes[status] || 'bg-gray-100 text-gray-800 border-gray-200';
	}

	function getPriorityBadgeClass(priority: number): string {
		if (priority >= 75) return 'bg-red-500 text-white';
		if (priority >= 50) return 'bg-orange-500 text-white';
		if (priority >= 25) return 'bg-yellow-500 text-white';
		return 'bg-green-500 text-white';
	}

	function formatDate(dateString: string): string {
		const date = new Date(dateString);
		return date.toLocaleDateString('en-US', { 
			year: 'numeric', 
			month: 'short', 
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	// Patient Info
	let patientName = '';
	let patientAge: number | '' = '';
	let patientGender = 'male';
	let patientPhone = '';
	let patientVillage = '';
	let emergencyContact = '';

	// Symptoms
	let selectedSymptoms: string[] = [];
	const symptomOptions = [
		'fever', 'cough', 'difficulty breathing', 'headache', 'body ache',
		'sore throat', 'nausea', 'vomiting', 'diarrhea', 'chest pain',
		'fatigue', 'loss of appetite', 'rash', 'joint pain', 'dizziness'
	];

	// Vital Signs
	let temperature: number | '' = '';
	let bloodPressure = '';
	let heartRate: number | '' = '';
	let oxygenSaturation: number | '' = '';
	let respiratoryRate: number | '' = '';

	// Media Capture
	let capturedImages: { file: File; dataUrl: string; analysis?: any }[] = [];
	let capturedAudio: { blob: Blob; dataUrl: string; analysis?: any } | null = null;
	let isRecording = false;
	let recordingDuration = 0;
	let recordingInterval: any = null;

	// Camera
	let videoElement: HTMLVideoElement;
	let canvasElement: HTMLCanvasElement;
	let stream: MediaStream | null = null;
	let isCameraActive = false;

	// AI Analysis
	let riskAssessment: RiskAssessment | null = null;
	let isAnalyzing = false;

	// Form State
	let isSaving = false;
	let saveMessage = '';
	let notes = '';

	// Camera Functions
	async function startCamera() {
		try {
			stream = await navigator.mediaDevices.getUserMedia({ 
				video: { 
					facingMode: 'environment',
					width: { ideal: 1280 },
					height: { ideal: 720 }
				} 
			});
			if (videoElement) {
				videoElement.srcObject = stream;
				isCameraActive = true;
			}
		} catch (error) {
			console.error('Camera error:', error);
			alert('Failed to access camera. Please check permissions.');
		}
	}

	async function captureImage() {
		if (!videoElement || !canvasElement) return;

		const context = canvasElement.getContext('2d');
		if (!context) return;

		canvasElement.width = videoElement.videoWidth;
		canvasElement.height = videoElement.videoHeight;
		context.drawImage(videoElement, 0, 0);

		canvasElement.toBlob(async (blob) => {
			if (!blob) return;

			const file = new File([blob], `image-${Date.now()}.jpg`, { type: 'image/jpeg' });
			const dataUrl = await readFileAsDataURL(file);

			// Analyze image
			const img = await loadImage(dataUrl);
			const analysis = await analyzeImage(img);

			capturedImages = [...capturedImages, { file, dataUrl, analysis }];
		}, 'image/jpeg', 0.9);
	}

	function stopCamera() {
		if (stream) {
			stream.getTracks().forEach(track => track.stop());
			stream = null;
			isCameraActive = false;
		}
	}

	function removeImage(index: number) {
		capturedImages = capturedImages.filter((_, i) => i !== index);
	}

	// Audio Functions
	async function startRecording() {
		try {
			isRecording = true;
			recordingDuration = 0;
			
			// Start duration counter
			recordingInterval = setInterval(() => {
				recordingDuration++;
			}, 1000);

			// Record 10 seconds
			const audioBlob = await recordAudio(10000);
			
			clearInterval(recordingInterval);
			isRecording = false;

			// Analyze audio
			const analysis = await analyzeAudio(audioBlob);
			const dataUrl = URL.createObjectURL(audioBlob);

			capturedAudio = { blob: audioBlob, dataUrl, analysis };

		} catch (error) {
			console.error('Recording error:', error);
			alert('Failed to record audio. Please check microphone permissions.');
			isRecording = false;
			clearInterval(recordingInterval);
		}
	}

	function removeAudio() {
		if (capturedAudio?.dataUrl) {
			URL.revokeObjectURL(capturedAudio.dataUrl);
		}
		capturedAudio = null;
	}

	// Risk Analysis
	function calculateRisk() {
		if (selectedSymptoms.length === 0) {
			alert('Please select at least one symptom');
			return;
		}

		isAnalyzing = true;

		// Gather vital signs
		const vitalSigns: any = {};
		if (temperature) vitalSigns.temperature = Number(temperature);
		if (bloodPressure) vitalSigns.bloodPressure = bloodPressure;
		if (heartRate) vitalSigns.heartRate = Number(heartRate);
		if (oxygenSaturation) vitalSigns.oxygenSaturation = Number(oxygenSaturation);
		if (respiratoryRate) vitalSigns.respiratoryRate = Number(respiratoryRate);

		// Get AI predictions
		const imageAnalysis = capturedImages[0]?.analysis;
		const audioAnalysis = capturedAudio?.analysis;

		const aiConfidence = imageAnalysis?.confidence || audioAnalysis?.confidence || 0;
		const aiPrediction = imageAnalysis?.condition || audioAnalysis?.condition;

		// Calculate risk
		riskAssessment = calculateRiskScore({
			symptoms: selectedSymptoms,
			vitalSigns: Object.keys(vitalSigns).length > 0 ? vitalSigns : undefined,
			age: typeof patientAge === 'number' ? patientAge : undefined,
			aiConfidence: aiConfidence > 0 ? aiConfidence : undefined,
			aiPrediction
		});

		isAnalyzing = false;
	}

	// Save Case
	async function saveCase() {
		if (!patientName || !patientAge || selectedSymptoms.length === 0) {
			alert('Please fill in patient name, age, and select at least one symptom');
			return;
		}

		// Calculate risk if not done
		if (!riskAssessment) {
			calculateRisk();
		}

		isSaving = true;
		saveMessage = '';

		try {
			// Save images to localStorage
			const imageUrls = await Promise.all(
				capturedImages.map(async (img, idx) => {
					const key = `image_${Date.now()}_${idx}`;
					localStorage.setItem(key, img.dataUrl);
					return key;
				})
			);

			// Save audio to localStorage
			let audioUrl = '';
			if (capturedAudio && capturedAudio.blob) {
				const key = `audio_${Date.now()}`;
				const reader = new FileReader();
				const audioDataUrl = await new Promise<string>((resolve) => {
					reader.onloadend = () => resolve(reader.result as string);
					reader.readAsDataURL(capturedAudio!.blob);
				});
				localStorage.setItem(key, audioDataUrl);
				audioUrl = key;
			}

			// Create case
			const caseData = {
				patient: {
					name: patientName,
					age: Number(patientAge),
					gender: patientGender,
					phone: patientPhone || undefined,
					village: patientVillage || undefined,
					emergencyContact: emergencyContact || undefined
				},
				symptoms: selectedSymptoms.join(', '),
				vitalSigns: {
					temperature: temperature || undefined,
					bloodPressure: bloodPressure || undefined,
					heartRate: heartRate || undefined,
					oxygenSaturation: oxygenSaturation || undefined,
					respiratoryRate: respiratoryRate || undefined
				},
				images: imageUrls,
				audioRecordings: audioUrl ? [audioUrl] : [],
				notes: notes || undefined
			};

			const result = await apiClient.cases.create(caseData);

			if (result.offline) {
				saveMessage = `🟠 Saved Offline. Will sync when online. ID: ${result.id}`;
			} else {
				saveMessage = `✅ Case saved successfully! ID: ${result.id}`;
			}

			// Send alert if high risk (only if online)
			if (!result.offline && riskAssessment && (riskAssessment.level === 'HIGH' || riskAssessment.level === 'CRITICAL')) {
				try {
					console.log('[CHW] Sending alert for critical case:', {
						level: riskAssessment.level,
						score: riskAssessment.score,
						priority: riskAssessment.priority
					});

					if (selectedAshaId) {
						await apiClient.alerts.create({
							caseId: result.id,
							recipientId: selectedAshaId,
							level: riskAssessment.level,
							message: `High Risk Case: ${patientName} (${patientAge}) - ${riskAssessment.level} Risk. Symptoms: ${selectedSymptoms.join(', ')}`
						});
						saveMessage = `✅ Case saved & Alert sent! ID: ${result.id}`;
					} else {
						console.warn('No ASHA worker selected for alert');
						saveMessage = `✅ Case saved (Alert skipped - No ASHA found). ID: ${result.id}`;
					}
				} catch (alertError) {
					console.error('Failed to send alert:', alertError);
				}
			}

		} catch (error: any) {
			console.error('Save error:', error);
			saveMessage = `❌ Failed to save: ${error.message || 'Unknown error'}`;
		} finally {
			isSaving = false;
		}
	}

	function resetForm() {
		patientName = '';
		patientAge = '';
		patientGender = 'male';
		patientPhone = '';
		patientVillage = '';
		emergencyContact = '';
		selectedSymptoms = [];
		temperature = '';
		bloodPressure = '';
		heartRate = '';
		oxygenSaturation = '';
		respiratoryRate = '';
		notes = '';
		capturedImages = [];
		capturedAudio = null;
		riskAssessment = null;
		saveMessage = '';
	}

	function readFileAsDataURL(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	onMount(() => {
		return () => {
			stopCamera();
			if (recordingInterval) clearInterval(recordingInterval);
		};
	});
</script>

<div class="min-h-screen bg-background">
	{#if unauthorized}
		<!-- Unauthorized Access Message -->
		<div class="flex min-h-screen items-center justify-center p-4">
			<div class="max-w-md w-full bg-surface rounded-2xl shadow-xl p-8 text-center">
				<div class="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
					<svg class="w-10 h-10 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
					</svg>
				</div>
				<h2 class="text-2xl font-bold text-surface-emphasis mb-3">Access Denied</h2>
				<p class="text-surface-muted mb-6">
					You don't have permission to access the CHW Portal.
				</p>
				<div class="space-y-3">
					<p class="text-sm text-surface-muted">Your role: <strong>{$authStore.user?.role}</strong></p>
					<a href="/" class="block w-full bg-green-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-green-700 transition-colors">
						Return to Home
					</a>
				</div>
			</div>
		</div>
	{:else}
	<div class="w-full">
		<!-- Header -->
		<header class="bg-surface shadow-sm border-b border-border/50 sticky top-0 z-50 backdrop-blur-md bg-surface/90 mb-8">
			<div class="px-6 py-4 flex items-center justify-between">
				<div class="flex items-center gap-4">
					<a
						href="/"
						aria-label="Home"
						class="w-10 h-10 bg-brand rounded-xl flex items-center justify-center hover:bg-brand/90 transition-all shadow-sm hover:shadow-brand/20"
					>
						<svg class="w-6 h-6 text-brand-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
							/>
						</svg>
					</a>
					<div>
						<h1 class="text-xl font-bold text-surface-emphasis">CHW Field App</h1>
						<p class="text-sm text-muted">Community Health Worker Data Collection</p>
					</div>
				</div>
				<div class="flex items-center gap-4">
					<button
						type="button"
						onclick={() => showNotifications = !showNotifications}
						class="relative rounded-xl p-2 text-muted hover:bg-surface-soft hover:text-brand transition-colors"
						aria-label="Notifications"
					>
						<svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
						</svg>
					</button>
					<div class="flex items-center gap-3">
						<div class="hidden md:block text-right">
							<p class="text-sm font-bold text-surface-emphasis">{$authStore.user?.name}</p>
							<p class="text-xs text-muted">{$authStore.user?.role}</p>
						</div>
						<div class="h-10 w-10 rounded-full bg-brand/10 flex items-center justify-center text-brand font-bold border border-brand/20">
							{$authStore.user?.name?.charAt(0) || 'C'}
						</div>
					</div>
				</div>
			</div>
		</header>

			<!-- Tabs -->
			<div class="mt-6 flex gap-2 border-b border-border">
				<button
					type="button"
					onclick={() => activeTab = 'new-case'}
					class="px-6 py-3 font-semibold transition-colors {activeTab === 'new-case' 
						? 'border-b-2 border-brand text-brand' 
						: 'text-surface-muted hover:text-surface-emphasis'}"
				>
					📝 New Case
				</button>
				<button
					type="button"
					onclick={() => activeTab = 'case-history'}
					class="px-6 py-3 font-semibold transition-colors {activeTab === 'case-history' 
						? 'border-b-2 border-brand text-brand' 
						: 'text-surface-muted hover:text-surface-emphasis'}"
				>
					📋 Case History
					{#if myCases.length > 0}
						<span class="ml-2 rounded-full bg-brand px-2 py-0.5 text-xs text-white">
							{myCases.length}
						</span>
					{/if}
				</button>
			</div>

		{#if activeTab === 'new-case'}
			<!-- New Case Form -->
			{#if saveMessage}
				<div class="mb-6 rounded-lg {saveMessage.startsWith('✅') ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'} p-4 font-medium">
					{saveMessage}
				</div>
			{/if}

			<form class="space-y-6">
			<!-- Patient Information -->
			<div class="rounded-2xl bg-surface p-6 shadow-lg">
				<h2 class="mb-4 text-xl font-bold text-surface-emphasis">Patient Information</h2>
				
				<div class="grid gap-4 md:grid-cols-2">
					<div>
						<label for="name" class="mb-1 block text-sm font-medium text-surface-emphasis">Name *</label>
						<input
							type="text"
							id="name"
							bind:value={patientName}
							required
							class="w-full rounded-lg border border-border bg-surface-soft px-4 py-2 text-surface-emphasis focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
							placeholder="Patient's full name"
						/>
					</div>

					<div>
						<label for="age" class="mb-1 block text-sm font-medium text-surface-emphasis">Age *</label>
						<input
							type="number"
							id="age"
							bind:value={patientAge}
							required
							min="0"
							max="120"
							class="w-full rounded-lg border border-border bg-surface-soft px-4 py-2 text-surface-emphasis focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
							placeholder="Age in years"
						/>
					</div>

					<div>
						<label for="gender" class="mb-1 block text-sm font-medium text-surface-emphasis">Gender</label>
						<select
							id="gender"
							bind:value={patientGender}
							class="w-full rounded-lg border border-border bg-surface-soft px-4 py-2 text-surface-emphasis focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
						>
							<option value="male">Male</option>
							<option value="female">Female</option>
							<option value="other">Other</option>
						</select>
					</div>

					<div>
						<label for="phone" class="mb-1 block text-sm font-medium text-surface-emphasis">Phone</label>
						<input
							type="tel"
							id="phone"
							bind:value={patientPhone}
							class="w-full rounded-lg border border-border bg-surface-soft px-4 py-2 text-surface-emphasis focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
							placeholder="+91 9876543210"
						/>
					</div>

					<div>
						<label for="village" class="mb-1 block text-sm font-medium text-surface-emphasis">Village</label>
						<input
							type="text"
							id="village"
							bind:value={patientVillage}
							class="w-full rounded-lg border border-border bg-surface-soft px-4 py-2 text-surface-emphasis focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
							placeholder="Village name"
						/>
					</div>

					<div>
						<label for="emergency" class="mb-1 block text-sm font-medium text-surface-emphasis">Emergency Contact</label>
						<input
							type="tel"
							id="emergency"
							bind:value={emergencyContact}
							class="w-full rounded-lg border border-border bg-surface-soft px-4 py-2 text-surface-emphasis focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
							placeholder="+91 9876543210"
						/>
					</div>
				</div>
			</div>

			<!-- Symptoms -->
			<div class="rounded-2xl bg-surface p-6 shadow-lg">
				<h2 class="mb-4 text-xl font-bold text-surface-emphasis">Symptoms *</h2>
				
				<div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
					{#each symptomOptions as symptom}
						<label class="flex items-center gap-2 cursor-pointer rounded-lg border border-border p-3 transition-colors hover:bg-surface-soft {selectedSymptoms.includes(symptom) ? 'bg-brand/10 border-brand/30' : ''}">
							<input
								type="checkbox"
								value={symptom}
								bind:group={selectedSymptoms}
								class="h-4 w-4 rounded border-border text-brand focus:ring-2 focus:ring-brand"
							/>
							<span class="text-sm font-medium text-surface-emphasis capitalize">{symptom}</span>
						</label>
					{/each}
				</div>
			</div>

			<!-- Vital Signs -->
			<div class="rounded-2xl bg-surface p-6 shadow-lg">
				<h2 class="mb-4 text-xl font-bold text-surface-emphasis">Vital Signs</h2>
				
				<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					<div>
						<label for="temp" class="mb-1 block text-sm font-medium text-surface-emphasis">Temperature (°C)</label>
						<input
							type="number"
							id="temp"
							bind:value={temperature}
							step="0.1"
							class="w-full rounded-lg border border-border bg-surface-soft px-4 py-2 text-surface-emphasis focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
							placeholder="37.0"
						/>
					</div>

					<div>
						<label for="bp" class="mb-1 block text-sm font-medium text-surface-emphasis">Blood Pressure</label>
						<input
							type="text"
							id="bp"
							bind:value={bloodPressure}
							class="w-full rounded-lg border border-border bg-surface-soft px-4 py-2 text-surface-emphasis focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
							placeholder="120/80"
						/>
					</div>

					<div>
						<label for="hr" class="mb-1 block text-sm font-medium text-surface-emphasis">Heart Rate (bpm)</label>
						<input
							type="number"
							id="hr"
							bind:value={heartRate}
							class="w-full rounded-lg border border-border bg-surface-soft px-4 py-2 text-surface-emphasis focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
							placeholder="75"
						/>
					</div>

					<div>
						<label for="spo2" class="mb-1 block text-sm font-medium text-surface-emphasis">Oxygen Saturation (%)</label>
						<input
							type="number"
							id="spo2"
							bind:value={oxygenSaturation}
							min="0"
							max="100"
							class="w-full rounded-lg border border-border bg-surface-soft px-4 py-2 text-surface-emphasis focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
							placeholder="98"
						/>
					</div>

					<div>
						<label for="rr" class="mb-1 block text-sm font-medium text-surface-emphasis">Respiratory Rate</label>
						<input
							type="number"
							id="rr"
							bind:value={respiratoryRate}
							class="w-full rounded-lg border border-border bg-surface-soft px-4 py-2 text-surface-emphasis focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
							placeholder="16"
						/>
					</div>
				</div>
			</div>

			<!-- Camera Capture -->
			<div class="rounded-2xl bg-surface p-6 shadow-lg">
				<h2 class="mb-4 text-xl font-bold text-surface-emphasis">📸 Image Capture</h2>
				
				<div class="space-y-4">
					{#if !isCameraActive}
						<button
							type="button"
							onclick={startCamera}
							class="w-full rounded-lg bg-green-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-green-700"
						>
							Start Camera
						</button>
					{:else}
						<div class="space-y-4">
							<!-- Video Preview -->
							<video
								bind:this={videoElement}
								autoplay
								playsinline
								class="w-full rounded-lg bg-black"
							>
								<track kind="captions" />
							</video>
							<canvas bind:this={canvasElement} class="hidden"></canvas>

							<div class="flex gap-3">
								<button
									type="button"
									onclick={captureImage}
									class="flex-1 rounded-lg bg-brand px-6 py-3 font-semibold text-white transition-colors hover:bg-brand/90"
								>
									📷 Capture Photo
								</button>
								<button
									type="button"
									onclick={stopCamera}
									class="rounded-lg bg-surface-muted px-6 py-3 font-semibold text-white transition-colors hover:bg-surface-emphasis"
								>
									Stop Camera
								</button>
							</div>
						</div>
					{/if}

					<!-- Captured Images -->
					{#if capturedImages.length > 0}
						<div class="mt-4 grid gap-4 sm:grid-cols-2">
							{#each capturedImages as image, index}
								<div class="relative rounded-lg border border-border p-3">
									<img src={image.dataUrl} alt="Captured" class="w-full rounded-lg" />
									
									{#if image.analysis}
										<div class="mt-2 rounded-lg bg-surface-soft p-3 text-sm">
											<p class="font-semibold text-surface-emphasis">{image.analysis.condition}</p>
											<p class="text-surface-muted">Confidence: {(image.analysis.confidence * 100).toFixed(1)}%</p>
											<p class="text-surface-muted">Severity: {image.analysis.severity}</p>
										</div>
									{/if}

									<button
										type="button"
										onclick={() => removeImage(index)}
										class="absolute top-5 right-5 rounded-full bg-red-600 p-2 text-white hover:bg-red-700"
										aria-label="Remove image"
									>
										✕
									</button>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</div>

			<!-- Audio Recording -->
			<div class="rounded-2xl bg-surface p-6 shadow-lg">
				<h2 class="mb-4 text-xl font-bold text-surface-emphasis">🎙️ Audio Recording</h2>
				
				<div class="space-y-4">
					{#if !capturedAudio}
						{#if !isRecording}
							<button
								type="button"
								onclick={startRecording}
								class="w-full rounded-lg bg-red-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-red-700"
							>
								🎙️ Record Breathing/Cough (10s)
							</button>
						{:else}
							<div class="rounded-lg bg-red-50 p-6 text-center">
								<div class="text-4xl font-bold text-red-600">{recordingDuration}s</div>
								<p class="mt-2 text-surface-muted">Recording... Please breathe or cough near the microphone</p>
								<div class="mt-4 flex justify-center">
									<div class="h-2 w-2 animate-ping rounded-full bg-red-600"></div>
								</div>
							</div>
						{/if}
					{:else}
						<div class="rounded-lg border border-border p-4">
							<audio controls src={capturedAudio.dataUrl} class="w-full"></audio>
							
							{#if capturedAudio.analysis}
								<div class="mt-3 rounded-lg bg-surface-soft p-3 text-sm">
									<p class="font-semibold text-surface-emphasis">{capturedAudio.analysis.condition}</p>
									<p class="text-surface-muted">Confidence: {(capturedAudio.analysis.confidence * 100).toFixed(1)}%</p>
									<p class="text-surface-muted">Severity: {capturedAudio.analysis.severity}</p>
									{#if capturedAudio.analysis.audioFeatures.breathingRate}
										<p class="text-surface-muted">Breathing Rate: {capturedAudio.analysis.audioFeatures.breathingRate} breaths/min</p>
									{/if}
								</div>
							{/if}

							<button
								type="button"
								onclick={removeAudio}
								class="mt-3 w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
							>
								Remove Recording
							</button>
						</div>
					{/if}
				</div>
			</div>

			<!-- Notes -->
			<div class="rounded-2xl bg-surface p-6 shadow-lg">
				<h2 class="mb-4 text-xl font-bold text-surface-emphasis">Additional Notes</h2>
				<textarea
					bind:value={notes}
					rows="4"
					class="w-full rounded-lg border border-border bg-surface-soft px-4 py-2 text-surface-emphasis focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
					placeholder="Any additional observations or patient history..."
				></textarea>
			</div>

			<!-- Risk Assessment -->
			{#if riskAssessment}
				<div class="rounded-2xl bg-surface p-6 shadow-lg">
					<h2 class="mb-4 text-xl font-bold text-surface-emphasis">🤖 AI Risk Assessment</h2>
					
					<div class="space-y-4">
						<div class="flex items-center justify-between rounded-lg bg-gradient-to-r {
							riskAssessment.level === 'CRITICAL' ? 'from-red-500 to-red-600' :
							riskAssessment.level === 'HIGH' ? 'from-orange-500 to-orange-600' :
							riskAssessment.level === 'MEDIUM' ? 'from-yellow-500 to-yellow-600' :
							'from-green-500 to-green-600'
						} p-6 text-white">
							<div>
								<p class="text-sm font-medium opacity-90">Risk Level</p>
								<p class="text-3xl font-bold">{riskAssessment.level}</p>
							</div>
							<div class="text-right">
								<p class="text-sm font-medium opacity-90">Risk Score</p>
								<p class="text-3xl font-bold">{riskAssessment.score}/100</p>
							</div>
						</div>

						<div>
							<p class="mb-2 font-semibold text-surface-emphasis">Risk Factors:</p>
							<ul class="space-y-1">
								{#each riskAssessment.factors as factor}
									<li class="text-sm text-surface-muted">• {factor}</li>
								{/each}
							</ul>
						</div>

						<div>
							<p class="mb-2 font-semibold text-surface-emphasis">Recommendations:</p>
							<ul class="space-y-1">
								{#each riskAssessment.recommendations as rec}
									<li class="text-sm text-surface-muted">• {rec}</li>
								{/each}
							</ul>
						</div>
					</div>
				</div>
			{/if}

			<!-- Action Buttons -->
			<div class="flex gap-4">
				<button
					type="button"
					onclick={calculateRisk}
					disabled={isAnalyzing || selectedSymptoms.length === 0}
					class="flex-1 rounded-lg bg-purple-600 px-6 py-4 font-semibold text-white transition-colors hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{isAnalyzing ? 'Analyzing...' : '🤖 Calculate Risk Score'}
				</button>

				<button
					type="button"
					onclick={saveCase}
					disabled={isSaving || !patientName || !patientAge || selectedSymptoms.length === 0}
					class="flex-1 rounded-lg bg-brand px-6 py-4 font-semibold text-white transition-colors hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{isSaving ? 'Saving...' : '💾 Save Case'}
				</button>
			</div>

			<button
				type="button"
				onclick={resetForm}
				class="w-full rounded-lg border border-border bg-surface px-6 py-3 font-semibold text-surface-emphasis transition-colors hover:bg-surface-soft"
			>
				Reset Form
			</button>
		</form>

		{:else if activeTab === 'case-history'}
			<!-- Case History View -->
			<div class="space-y-4">
				{#if isLoadingCases}
					<div class="rounded-2xl bg-surface p-12 text-center shadow-lg">
						<div class="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-brand border-t-transparent"></div>
						<p class="mt-4 text-surface-muted">Loading your cases...</p>
					</div>
				{:else if myCases.length === 0}
					<div class="rounded-2xl bg-surface p-12 text-center shadow-lg">
						<div class="text-6xl">📋</div>
						<h3 class="mt-4 text-xl font-bold text-surface-emphasis">No Cases Yet</h3>
						<p class="mt-2 text-surface-muted">Create your first case using the "New Case" tab</p>
						<button
							type="button"
							onclick={() => activeTab = 'new-case'}
							class="mt-6 rounded-lg bg-brand px-6 py-3 font-semibold text-white hover:bg-brand/90"
						>
							Create New Case
						</button>
					</div>
				{:else}
					<!-- Statistics -->
					<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
						<div class="rounded-xl bg-surface p-4 shadow-lg">
							<p class="text-sm text-surface-muted">Total Cases</p>
							<p class="mt-1 text-3xl font-bold text-surface-emphasis">{myCases.length}</p>
						</div>
						<div class="rounded-xl bg-yellow-50 p-4 shadow-lg">
							<p class="text-sm text-yellow-800">Pending</p>
							<p class="mt-1 text-3xl font-bold text-yellow-600">
								{myCases.filter(c => c.status === 'PENDING').length}
							</p>
						</div>
						<div class="rounded-xl bg-green-50 p-4 shadow-lg">
							<p class="text-sm text-green-800">Approved</p>
							<p class="mt-1 text-3xl font-bold text-green-600">
								{myCases.filter(c => c.status === 'APPROVED').length}
							</p>
						</div>
						<div class="rounded-xl bg-red-50 p-4 shadow-lg">
							<p class="text-sm text-red-800">Rejected</p>
							<p class="mt-1 text-3xl font-bold text-red-600">
								{myCases.filter(c => c.status === 'REJECTED').length}
							</p>
						</div>
					</div>

					<!-- Case List -->
					<div class="space-y-3">
						{#each myCases as caseItem}
							<div class="rounded-2xl bg-surface p-6 shadow-lg transition-shadow hover:shadow-xl">
								<div class="flex items-start justify-between">
									<div class="flex-1">
										<div class="flex items-center gap-3">
											<h3 class="text-lg font-bold text-surface-emphasis">
												{caseItem.patient?.name || 'Unknown Patient'}
											</h3>
											<span class="rounded-full border px-3 py-1 text-xs font-semibold {getStatusBadgeClass(caseItem.status)}">
												{caseItem.status}
											</span>
											<span class="rounded-full px-2 py-1 text-xs font-semibold {getPriorityBadgeClass(caseItem.priority)}">
												Priority {caseItem.priority}
											</span>
										</div>
										
										<div class="mt-2 flex flex-wrap gap-4 text-sm text-surface-muted">
											<span>👤 Age: {caseItem.patient?.age || 'N/A'}</span>
											<span>🏥 {caseItem.chiefComplaint || 'No complaint'}</span>
											<span>📅 {formatDate(caseItem.createdAt)}</span>
										</div>

										{#if caseItem.status === 'APPROVED' || caseItem.status === 'REJECTED'}
											<div class="mt-3 rounded-lg {caseItem.status === 'APPROVED' ? 'bg-green-50' : 'bg-red-50'} p-3">
												<p class="text-sm font-semibold {caseItem.status === 'APPROVED' ? 'text-green-900' : 'text-red-900'}">
													{caseItem.status === 'APPROVED' ? '✅ Approved by ASHA' : '❌ Rejected by ASHA'}
												</p>
												{#if caseItem.reviewNotes}
													<p class="mt-1 text-sm {caseItem.status === 'APPROVED' ? 'text-green-700' : 'text-red-700'}">
														Feedback: {caseItem.reviewNotes}
													</p>
												{/if}
											</div>
										{/if}
									</div>

									<button
										type="button"
										onclick={() => viewCaseDetails(caseItem)}
										class="ml-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90"
									>
										View Details
									</button>
								</div>
							</div>
						{/each}
					</div>

					<!-- Refresh Button -->
					<button
						type="button"
						onclick={loadMyCases}
						disabled={isLoadingCases}
						class="w-full rounded-lg border border-border bg-surface px-6 py-3 font-semibold text-surface-emphasis transition-colors hover:bg-surface-soft disabled:opacity-50"
					>
						{isLoadingCases ? 'Refreshing...' : '🔄 Refresh Cases'}
					</button>
				{/if}
			</div>
		{/if}
	</div>
	{/if}
</div>

<!-- Case Details Modal -->
{#if showCaseModal && selectedCaseDetails}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
	<div 
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" 
		role="dialog" 
		aria-modal="true"
		tabindex="-1"
		onclick={closeCaseModal}
	>
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div 
			class="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-surface shadow-2xl" 
			onclick={(e) => e.stopPropagation()}
		>
			<div class="sticky top-0 flex items-center justify-between border-b border-border bg-surface p-6">
				<h2 class="text-2xl font-bold text-surface-emphasis">Case Details</h2>
				<button
					type="button"
					onclick={closeCaseModal}
					aria-label="Close modal"
					class="rounded-lg p-2 text-surface-muted hover:bg-surface-soft"
				>
					<svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
					</svg>
				</button>
			</div>

			<div class="p-6 space-y-6">
				<!-- Case Status -->
				<div class="rounded-xl {
					selectedCaseDetails.status === 'APPROVED' ? 'bg-green-50 border-green-200' :
					selectedCaseDetails.status === 'REJECTED' ? 'bg-red-50 border-red-200' :
					'bg-yellow-50 border-yellow-200'
				} border p-4">
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm font-medium text-surface-muted">Case Status</p>
							<p class="mt-1 text-2xl font-bold {
								selectedCaseDetails.status === 'APPROVED' ? 'text-green-600' :
								selectedCaseDetails.status === 'REJECTED' ? 'text-red-600' :
								'text-yellow-600'
							}">
								{selectedCaseDetails.status}
							</p>
						</div>
						<div class="text-right">
							<p class="text-sm font-medium text-surface-muted">Priority Level</p>
							<p class="mt-1 text-2xl font-bold text-surface-emphasis">{selectedCaseDetails.priority}</p>
						</div>
					</div>
				</div>

				<!-- Patient Information -->
				<div>
					<h3 class="text-lg font-bold text-surface-emphasis mb-3">Patient Information</h3>
					<div class="grid grid-cols-2 gap-4 rounded-xl bg-surface-soft p-4">
						<div>
							<p class="text-sm text-surface-muted">Name</p>
							<p class="font-semibold text-surface-emphasis">{selectedCaseDetails.patient?.name || 'N/A'}</p>
						</div>
						<div>
							<p class="text-sm text-surface-muted">Age</p>
							<p class="font-semibold text-surface-emphasis">{selectedCaseDetails.patient?.age || 'N/A'}</p>
						</div>
						<div>
							<p class="text-sm text-surface-muted">Gender</p>
							<p class="font-semibold text-surface-emphasis">{selectedCaseDetails.patient?.gender || 'N/A'}</p>
						</div>
						<div>
							<p class="text-sm text-surface-muted">Phone</p>
							<p class="font-semibold text-surface-emphasis">{selectedCaseDetails.patient?.phone || 'N/A'}</p>
						</div>
					</div>
				</div>

				<!-- Chief Complaint -->
				{#if selectedCaseDetails.chiefComplaint}
					<div>
						<h3 class="text-lg font-bold text-surface-emphasis mb-3">Chief Complaint</h3>
						<p class="rounded-xl bg-surface-soft p-4 text-surface-emphasis">{selectedCaseDetails.chiefComplaint}</p>
					</div>
				{/if}

				<!-- Case Dates -->
				<div>
					<h3 class="text-lg font-bold text-surface-emphasis mb-3">Timeline</h3>
					<div class="space-y-2 rounded-xl bg-surface-soft p-4">
						<div class="flex items-center gap-2 text-sm">
							<span class="font-semibold text-surface-emphasis">Created:</span>
							<span class="text-surface-muted">{formatDate(selectedCaseDetails.createdAt)}</span>
						</div>
						{#if selectedCaseDetails.updatedAt !== selectedCaseDetails.createdAt}
							<div class="flex items-center gap-2 text-sm">
								<span class="font-semibold text-surface-emphasis">Last Updated:</span>
								<span class="text-surface-muted">{formatDate(selectedCaseDetails.updatedAt)}</span>
							</div>
						{/if}
					</div>
				</div>

				<!-- ASHA Review Feedback -->
				{#if selectedCaseDetails.status === 'APPROVED' || selectedCaseDetails.status === 'REJECTED'}
					<div>
						<h3 class="text-lg font-bold text-surface-emphasis mb-3">ASHA Review</h3>
						<div class="rounded-xl {selectedCaseDetails.status === 'APPROVED' ? 'bg-green-50' : 'bg-red-50'} p-4">
							<p class="font-semibold {selectedCaseDetails.status === 'APPROVED' ? 'text-green-900' : 'text-red-900'}">
								{selectedCaseDetails.status === 'APPROVED' ? '✅ Case Approved' : '❌ Case Rejected'}
							</p>
							{#if selectedCaseDetails.reviewNotes}
								<p class="mt-2 text-sm {selectedCaseDetails.status === 'APPROVED' ? 'text-green-700' : 'text-red-700'}">
									<strong>Feedback:</strong> {selectedCaseDetails.reviewNotes}
								</p>
							{/if}
						</div>
					</div>
				{/if}
			</div>

			<div class="border-t border-border bg-surface-soft p-6">
				<button
					type="button"
					onclick={closeCaseModal}
					class="w-full rounded-lg bg-surface-muted px-6 py-3 font-semibold text-white hover:bg-surface-emphasis"
				>
					Close
				</button>
			</div>
		</div>
	</div>
{/if}


<!-- Notification Center -->
<NotificationCenter isOpen={showNotifications} onClose={() => showNotifications = false} />

