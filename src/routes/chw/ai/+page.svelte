<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { authStore } from '$lib/stores/auth-store';
	import { apiClient } from '$lib/api-client';
	import { get } from 'svelte/store';

	let unauthorized = false;
	let loading = false;
	let submitting = false;
	let aiThinking = false;
	let setupError = '';

	// Patient Information
	let patientName = '';
	let patientAge = '';
	let patientGender = 'MALE';
	let patientPhone = '';
	let patientVillage = '';

	// Multimodal inputs
	let uploadedImages: Array<{ url: string; file: File }> = [];
	let audioRecording: { url: string; blob: Blob } | null = null;
	let isRecording = false;
	let mediaRecorder: MediaRecorder | null = null;
	let audioChunks: Blob[] = [];

	// Chat/Conversation State
	type Message = {
		id: string;
		role: 'ai' | 'user';
		text: string;
		timestamp: Date;
	};

	type AIMessage = {
		role: 'user' | 'assistant';
		content: string;
	};

	let messages: Message[] = [];
	let conversationHistory: AIMessage[] = [];
	let awaitingResponse = false;
	let userInput = '';
	let showPatientForm = true;
	let diagnosisComplete = false;
	let questionCount = 0;

	// Diagnosis Result
	let diagnosisResult = {
		priority: 0,
		riskLevel: 'LOW' as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
		riskScore: 0,
		symptoms: [] as string[],
		recommendations: '',
		needsEscalation: false,
		escalateTo: '' as 'ASHA' | 'CLINICIAN' | '',
		summary: ''
	};

	// Demo ASHA Workers
	const nearbyAshaWorkers = [
		{ name: 'Anita Sharma', location: 'Village A (2 km)', phone: '+919876543210' },
		{ name: 'Priya Devi', location: 'Village B (3 km)', phone: '+919876543211' },
		{ name: 'Sunita Kumari', location: 'Village C (5 km)', phone: '+919876543212' }
	];

	// Image Upload Handler
	async function handleImageUpload(event: Event) {
		const target = event.target as HTMLInputElement;
		const files = target.files;
		
		if (!files || files.length === 0) return;

		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			
			// Create preview URL
			const previewUrl = URL.createObjectURL(file);
			uploadedImages = [...uploadedImages, { url: previewUrl, file }];

			// Upload to server
			try {
				const formData = new FormData();
				formData.append('file', file);
				formData.append('type', 'image');

				const response = await fetch('/api/upload', {
					method: 'POST',
					body: formData
				});

				if (!response.ok) {
					throw new Error('Upload failed');
				}

				const data = await response.json();
				console.log('Image uploaded:', data.url);
			} catch (error) {
				console.error('Image upload error:', error);
				alert('Failed to upload image');
			}
		}
	}

	function removeImage(index: number) {
		uploadedImages = uploadedImages.filter((_, i) => i !== index);
	}

	// Voice Recording Handlers
	async function startRecording() {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			mediaRecorder = new MediaRecorder(stream);
			audioChunks = [];

			mediaRecorder.ondataavailable = (event) => {
				audioChunks.push(event.data);
			};

			mediaRecorder.onstop = async () => {
				const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
				const audioUrl = URL.createObjectURL(audioBlob);
				audioRecording = { url: audioUrl, blob: audioBlob };

				// Upload to server
				try {
					const formData = new FormData();
					formData.append('file', audioBlob, 'recording.webm');
					formData.append('type', 'audio');

					const response = await fetch('/api/upload', {
						method: 'POST',
						body: formData
					});

					if (!response.ok) {
						throw new Error('Upload failed');
					}

					const data = await response.json();
					console.log('Audio uploaded:', data.url);
				} catch (error) {
					console.error('Audio upload error:', error);
					alert('Failed to upload audio');
				}

				// Stop all tracks
				stream.getTracks().forEach((track) => track.stop());
			};

			mediaRecorder.start();
			isRecording = true;
		} catch (error) {
			console.error('Recording error:', error);
			alert('Failed to start recording. Please check microphone permissions.');
		}
	}

	function stopRecording() {
		if (mediaRecorder && isRecording) {
			mediaRecorder.stop();
			isRecording = false;
		}
	}

	function removeAudio() {
		audioRecording = null;
	}

	// AI Functions
	function addMessage(role: 'ai' | 'user', text: string) {
		messages = [
			...messages,
			{
				id: Date.now().toString(),
				role,
				text,
				timestamp: new Date()
			}
		];
		awaitingResponse = role === 'ai';
		
		setTimeout(() => {
			const chatContainer = document.getElementById('chat-container');
			if (chatContainer) {
				chatContainer.scrollTop = chatContainer.scrollHeight;
			}
		}, 100);
	}

	async function callAI(userMessage: string): Promise<void> {
		aiThinking = true;
		
		try {
			// Add user message to conversation history
			conversationHistory.push({
				role: 'user',
				content: userMessage
			});

			// Build enhanced context with multimodal info
			let enhancedMessage = userMessage;
			if (uploadedImages.length > 0) {
				enhancedMessage += `\n\n[Note: Patient has ${uploadedImages.length} image(s) uploaded for visual assessment]`;
			}
			if (audioRecording) {
				enhancedMessage += `\n[Note: Voice recording available - analyze for respiratory distress, pain level, voice quality]`;
			}

			// Call backend AI API
			const response = await fetch('/api/ai/chat', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					messages: [{
						role: 'user',
						content: enhancedMessage
					}, ...conversationHistory],
					patientInfo: {
						name: patientName,
						age: patientAge,
						gender: patientGender,
						village: patientVillage,
						hasImages: uploadedImages.length > 0,
						hasAudio: audioRecording !== null
					}
				})
			});

			const data = await response.json();

			if (!response.ok) {
				if (data.setup_required || data.auth_error || data.quota_error) {
					setupError = data.error;
					addMessage('ai', 'Warning: ' + data.error);
					awaitingResponse = false;
					aiThinking = false;
					return;
				}
				throw new Error(data.error || 'AI request failed');
			}

			// Add AI response to conversation history
			conversationHistory.push({
				role: 'assistant',
				content: data.message
			});

			// Add AI message to UI
			addMessage('ai', data.message);

			// Check if diagnosis is complete
			if (data.diagnosis_complete) {
				diagnosisComplete = true;
				diagnosisResult = {
					priority: data.priority || 0,
					riskLevel: data.risk_level || 'LOW',
					riskScore: data.risk_score || 0,
					symptoms: data.symptoms || [],
					recommendations: data.recommendations || '',
					needsEscalation: data.escalate_to !== '',
					escalateTo: data.escalate_to || '',
					summary: data.summary || data.message
				};
			}

			questionCount++;
			aiThinking = false;
		} catch (error: any) {
			console.error('AI Error:', error);
			addMessage('ai', 'Sorry, I encountered an error. Please try again.');
			aiThinking = false;
		}
	}

	async function startDiagnosis() {
		if (!patientName || !patientAge || !patientGender) {
			alert('Please fill in all required patient information');
			return;
		}
		
		showPatientForm = false;
		setupError = '';
		
		// Welcome message
		addMessage('ai', `Hello! I'm your AI health assistant. Let's assess ${patientName}'s condition together. I'll ask you a few questions to understand the situation better.`);
		
		// Start conversation with AI
		setTimeout(async () => {
			await callAI("Please start the health assessment. Ask your first question about the patient's condition.");
		}, 1000);
	}

	async function handleSendMessage() {
		if (!userInput.trim() || !awaitingResponse || aiThinking) return;
		
		const message = userInput;
		userInput = '';
		
		// Add user message to UI
		addMessage('user', message);
		
		awaitingResponse = false;
		
		// Call AI with user's response
		await callAI(message);
	}

	async function submitCase() {
		if (!diagnosisResult) return;
		
		submitting = true;
		
		try {
			// Build conversation summary
			const conversationSummary = messages
				.map((msg) => `${msg.role === 'ai' ? 'AI' : 'CHW'}: ${msg.text}`)
				.join('\n');

			// Collect image URLs
			const imageUrls = uploadedImages.map(img => img.url);

			const caseData: any = {
				patient: {
					name: patientName,
					age: parseInt(patientAge),
					gender: patientGender,
					phone: patientPhone,
					village: patientVillage
				},
				symptoms: diagnosisResult.symptoms.join(', '),
				notes: `AI Assessment:\n${diagnosisResult.summary}\n\nRisk Level: ${diagnosisResult.riskLevel}\nRisk Score: ${diagnosisResult.riskScore}/100\n\nRecommendations: ${diagnosisResult.recommendations}\n\nFull Conversation:\n${conversationSummary}`,
				priority: diagnosisResult.priority,
				riskLevel: diagnosisResult.riskLevel,
				riskScore: diagnosisResult.riskScore,
				status: diagnosisResult.needsEscalation ? 'PENDING' : 'COMPLETED',
				vitalSigns: {},
				location: patientVillage,
				images: imageUrls.length > 0 ? JSON.stringify(imageUrls) : null,
				audioRecordings: audioRecording ? JSON.stringify([audioRecording.url]) : null
			};
			
			const response = await apiClient.cases.create(caseData);

			// If high/critical risk, send alert to ASHA worker
			if (diagnosisResult.riskLevel === 'HIGH' || diagnosisResult.riskLevel === 'CRITICAL') {
				await sendAshaAlert(response.case.id);
			}
			
			alert('Case submitted successfully!');
			
			// Reset form
			resetForm();
			
		} catch (error: any) {
			console.error('Error submitting case:', error);
			alert('Failed to submit case: ' + (error.message || 'Unknown error'));
		} finally {
			submitting = false;
		}
	}

	async function sendAshaAlert(caseId: string) {
		try {
			const user = get(authStore).user;
			await fetch('/api/alerts/send', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					caseId,
					patientName,
					patientPhone,
					symptoms: diagnosisResult.symptoms.join(', '),
					riskLevel: diagnosisResult.riskLevel,
					riskScore: diagnosisResult.riskScore,
					priority: diagnosisResult.priority,
					chwName: user?.name || 'CHW'
				})
			});
		} catch (error) {
			console.error('Failed to send alert:', error);
		}
	}

	function resetForm() {
		patientName = '';
		patientAge = '';
		patientGender = 'MALE';
		patientPhone = '';
		patientVillage = '';
		uploadedImages = [];
		audioRecording = null;
		messages = [];
		conversationHistory = [];
		showPatientForm = true;
		diagnosisComplete = false;
		awaitingResponse = false;
		aiThinking = false;
		questionCount = 0;
		setupError = '';
		diagnosisResult = {
			priority: 0,
			riskLevel: 'LOW',
			riskScore: 0,
			symptoms: [],
			recommendations: '',
			needsEscalation: false,
			escalateTo: '',
			summary: ''
		};
	}

	onMount(() => {
		const state = get(authStore);
		if (!state.isAuthenticated) {
			goto('/auth', { replaceState: true});
			return;
		}
		
		const allowedRoles = ['CHW', 'ASHA', 'ASHA_SUPERVISOR', 'CLINICIAN', 'DOCTOR', 'ADMIN'];
		if (!allowedRoles.includes(state.user?.role || '')) {
			unauthorized = true;
			return;
		}
	});
</script>

{#if unauthorized}
	<div class="flex min-h-screen items-center justify-center bg-gray-50 p-4">
		<div class="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
			<div class="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
				<svg class="w-10 h-10 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
				</svg>
			</div>
			<h2 class="text-2xl font-bold text-gray-900 mb-3">Access Denied</h2>
			<p class="text-gray-600 mb-6">
				You don't have permission to access this page.
			</p>
			<a href="/" class="block w-full bg-green-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-green-700 transition-colors">
				Return to Home
			</a>
		</div>
	</div>
{:else}
	<div class="min-h-screen bg-gray-50">
		<!-- Header -->
		<header class="bg-white shadow-sm border-b">
			<div class="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
				<div class="flex items-center gap-4">
					<a href="/" aria-label="Home" class="w-10 h-10 bg-green-600 rounded-lg flex items-center justify-center hover:bg-green-700 transition-colors">
						<svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>
						</svg>
					</a>
					<div>
						<h1 class="text-xl font-bold text-gray-900">AI Health Assessment</h1>
						<p class="text-sm text-gray-600">Intelligent diagnostic support powered by GPT-4</p>
					</div>
				</div>
				<div class="text-sm text-gray-600">
					CHW: {$authStore.user?.name}
				</div>
			</div>
		</header>

		<div class="max-w-5xl mx-auto p-4 py-8">
			{#if showPatientForm}
				<!-- Patient Information Form -->
				<div class="bg-white rounded-lg shadow-lg p-8">
					<h2 class="text-2xl font-bold text-gray-900 mb-6">Patient Information</h2>
					
					<div class="space-y-4">
						<div class="grid grid-cols-2 gap-4">
							<div>
								<label for="patient-name" class="block text-sm font-medium text-gray-700 mb-2">Patient Name *</label>
								<input
									id="patient-name"
									type="text"
									bind:value={patientName}
									placeholder="Enter full name"
									class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
								/>
							</div>
							
							<div>
								<label for="patient-age" class="block text-sm font-medium text-gray-700 mb-2">Age *</label>
								<input
									id="patient-age"
									type="number"
									bind:value={patientAge}
									placeholder="Age"
									min="0"
									max="120"
									class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
								/>
							</div>
						</div>
						
						<div class="grid grid-cols-2 gap-4">
							<div>
								<label for="patient-gender" class="block text-sm font-medium text-gray-700 mb-2">Gender *</label>
								<select
									id="patient-gender"
									bind:value={patientGender}
									class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
								>
									<option value="MALE">Male</option>
									<option value="FEMALE">Female</option>
									<option value="OTHER">Other</option>
								</select>
							</div>
							
							<div>
								<label for="patient-phone" class="block text-sm font-medium text-gray-700 mb-2">Phone Number</label>
								<input
									id="patient-phone"
									type="tel"
									bind:value={patientPhone}
									placeholder="+91 XXXXX XXXXX"
									class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
								/>
							</div>
						</div>
						
						<div>
							<label for="patient-village" class="block text-sm font-medium text-gray-700 mb-2">Village/Location</label>
							<input
								id="patient-village"
								type="text"
								bind:value={patientVillage}
								placeholder="Enter village or location"
								class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
							/>
						</div>

						<!-- Image Upload -->
						<div>
							<label for="image-upload" class="block text-sm font-medium text-gray-700 mb-2">Patient Images (Optional)</label>
							<div class="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-green-500 transition-colors">
								<input
									type="file"
									accept="image/*"
									multiple
									onchange={handleImageUpload}
									class="hidden"
									id="image-upload"
								/>
								<label for="image-upload" class="cursor-pointer">
									<svg class="w-12 h-12 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
									</svg>
									<p class="text-sm text-gray-600">Click to upload images</p>
									<p class="text-xs text-gray-500 mt-1">For skin conditions, wounds, rashes, etc.</p>
								</label>
							</div>

							{#if uploadedImages.length > 0}
								<div class="mt-4 grid grid-cols-3 gap-4">
									{#each uploadedImages as image, index}
										<div class="relative group">
											<img src={image.url} alt="Patient" class="w-full h-32 object-cover rounded-lg" />
											<button
												onclick={() => removeImage(index)}
												aria-label="Remove image"
												class="absolute top-2 right-2 bg-red-600 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
											>
												<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
												</svg>
											</button>
										</div>
									{/each}
								</div>
							{/if}
						</div>

						<!-- Voice Recording -->
						<div>
							<label for="voice-recording" class="block text-sm font-medium text-gray-700 mb-2">Voice Note (Optional)</label>
							<div id="voice-recording" class="border border-gray-300 rounded-lg p-4">
								{#if !audioRecording}
									{#if !isRecording}
										<button
											onclick={startRecording}
											class="w-full bg-blue-50 hover:bg-blue-100 text-blue-700 py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
										>
											<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>
											</svg>
											Record Patient's Voice
										</button>
										<p class="text-xs text-gray-500 mt-2 text-center">Helps analyze breathing patterns, pain level, voice quality</p>
									{:else}
										<button
											onclick={stopRecording}
											class="w-full bg-red-500 hover:bg-red-600 text-white py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 animate-pulse"
										>
											<div class="w-3 h-3 bg-white rounded-full"></div>
											Recording... Click to stop
										</button>
									{/if}
								{:else}
									<div class="flex items-center justify-between bg-green-50 p-3 rounded-lg">
										<div class="flex items-center gap-3">
											<svg class="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
											</svg>
											<div>
												<p class="font-medium text-gray-900">Voice recording captured</p>
												<audio controls src={audioRecording.url} class="mt-2 h-8"></audio>
											</div>
										</div>
										<button
											onclick={removeAudio}
											aria-label="Remove audio recording"
											class="text-red-600 hover:text-red-700"
										>
											<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
											</svg>
										</button>
									</div>
								{/if}
							</div>
						</div>

						<!-- Nearby ASHA Workers Info -->
						<div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
							<h3 class="font-medium text-blue-900 mb-2">Nearby ASHA Workers</h3>
							<div class="space-y-2">
								{#each nearbyAshaWorkers as worker}
									<div class="flex justify-between text-sm">
										<span class="text-blue-900">{worker.name}</span>
										<span class="text-blue-600">{worker.location}</span>
									</div>
								{/each}
							</div>
							<p class="text-xs text-blue-700 mt-2">High-risk cases will automatically alert the nearest ASHA worker</p>
						</div>
					</div>
					
					<button
						onclick={startDiagnosis}
						disabled={!patientName || !patientAge || !patientGender}
						class="w-full mt-6 bg-green-600 text-white px-6 py-4 rounded-lg font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg"
					>
						Start AI Assessment
					</button>
				</div>
			{:else if !diagnosisComplete}
				<!-- Chat Interface -->
				<div class="bg-white rounded-lg shadow-lg overflow-hidden">
					<!-- Chat Header -->
					<div class="bg-green-600 text-white p-6">
						<div class="flex items-center justify-between">
							<div>
								<h3 class="font-bold text-lg">AI Health Assistant</h3>
								<p class="text-sm text-white/90">Assessing {patientName}, {patientAge} years, {patientGender}</p>
							</div>
							<div class="text-right">
								<p class="text-xs text-white/80">Questions asked</p>
								<p class="text-2xl font-bold">{questionCount}</p>
							</div>
						</div>
					</div>
					
					<!-- Chat Messages -->
					<div id="chat-container" class="h-[500px] overflow-y-auto p-6 space-y-4 bg-gray-50">
						{#each messages as message}
							<div class="flex {message.role === 'ai' ? 'justify-start' : 'justify-end'}">
								<div class="max-w-[80%] {message.role === 'ai' ? 'bg-white border border-gray-200' : 'bg-green-600 text-white'} rounded-lg p-4 shadow-sm">
									{#if message.role === 'ai'}
										<div class="flex items-start gap-3">
											<div class="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
												<svg class="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
												</svg>
											</div>
											<div class="flex-1">
												<p class="text-sm font-medium text-gray-900 mb-1">AI Assistant</p>
												<p class="text-gray-700 whitespace-pre-wrap">{message.text}</p>
											</div>
										</div>
									{:else}
										<p class="whitespace-pre-wrap">{message.text}</p>
									{/if}
								</div>
							</div>
						{/each}

						{#if aiThinking}
							<div class="flex justify-start">
								<div class="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
									<div class="flex items-center gap-2">
										<div class="flex gap-1">
											<div class="w-2 h-2 bg-green-600 rounded-full animate-bounce"></div>
											<div class="w-2 h-2 bg-green-600 rounded-full animate-bounce" style="animation-delay: 0.2s"></div>
											<div class="w-2 h-2 bg-green-600 rounded-full animate-bounce" style="animation-delay: 0.4s"></div>
										</div>
										<span class="text-sm text-gray-600">AI is thinking...</span>
									</div>
								</div>
							</div>
						{/if}
					</div>
					
					<!-- Input Area -->
					<div class="border-t p-4 bg-white">
						{#if setupError}
							<div class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
								<p class="font-medium">Configuration Error</p>
								<p class="text-sm">{setupError}</p>
							</div>
						{/if}

						<div class="flex gap-3">
							<input
								type="text"
								bind:value={userInput}
								onkeydown={(e) => e.key === 'Enter' && handleSendMessage()}
								disabled={!awaitingResponse || aiThinking}
								placeholder={awaitingResponse ? 'Type your response...' : 'Please wait for AI question...'}
								class="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent disabled:bg-gray-100"
							/>
							<button
								onclick={handleSendMessage}
								disabled={!awaitingResponse || aiThinking || !userInput.trim()}
								class="bg-green-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
							>
								Send
							</button>
						</div>
					</div>
				</div>
			{:else}
				<!-- Diagnosis Result -->
				<div class="space-y-6">
					<!-- Risk Assessment Card -->
					<div class="bg-white rounded-lg shadow-lg p-8">
						<h2 class="text-2xl font-bold text-gray-900 mb-6">Assessment Complete</h2>
						
						<div class="grid grid-cols-3 gap-6 mb-8">
							<div class="text-center">
								<p class="text-sm text-gray-600 mb-2">Risk Level</p>
								<div class="inline-block px-6 py-3 rounded-lg font-bold text-lg
									{diagnosisResult.riskLevel === 'CRITICAL' ? 'bg-red-100 text-red-800' : ''}
									{diagnosisResult.riskLevel === 'HIGH' ? 'bg-orange-100 text-orange-800' : ''}
									{diagnosisResult.riskLevel === 'MEDIUM' ? 'bg-yellow-100 text-yellow-800' : ''}
									{diagnosisResult.riskLevel === 'LOW' ? 'bg-green-100 text-green-800' : ''}
								">
									{diagnosisResult.riskLevel}
								</div>
							</div>
							
							<div class="text-center">
								<p class="text-sm text-gray-600 mb-2">Risk Score</p>
								<div class="text-4xl font-bold text-gray-900">{diagnosisResult.riskScore}<span class="text-xl text-gray-500">/100</span></div>
							</div>
							
							<div class="text-center">
								<p class="text-sm text-gray-600 mb-2">Priority</p>
								<div class="text-4xl font-bold text-gray-900">{diagnosisResult.priority}<span class="text-xl text-gray-500">/5</span></div>
							</div>
						</div>

						{#if diagnosisResult.needsEscalation}
							<div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
								<p class="font-bold text-red-900 mb-2">Escalation Required</p>
								<p class="text-red-700">This case requires attention from: <span class="font-bold">{diagnosisResult.escalateTo}</span></p>
								<p class="text-sm text-red-600 mt-2">Alert will be sent automatically upon case submission</p>
							</div>
						{/if}

						<div class="space-y-4">
							<div>
								<h3 class="font-bold text-gray-900 mb-2">Identified Symptoms</h3>
								<div class="flex flex-wrap gap-2">
									{#each diagnosisResult.symptoms as symptom}
										<span class="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm">{symptom}</span>
									{/each}
								</div>
							</div>

							<div>
								<h3 class="font-bold text-gray-900 mb-2">Recommendations</h3>
								<div class="bg-gray-50 border border-gray-200 rounded-lg p-4">
									<p class="text-gray-700 whitespace-pre-wrap">{diagnosisResult.recommendations}</p>
								</div>
							</div>

							<div>
								<h3 class="font-bold text-gray-900 mb-2">Assessment Summary</h3>
								<div class="bg-gray-50 border border-gray-200 rounded-lg p-4">
									<p class="text-gray-700 whitespace-pre-wrap">{diagnosisResult.summary}</p>
								</div>
							</div>

							{#if uploadedImages.length > 0}
								<div>
									<h3 class="font-bold text-gray-900 mb-2">Attached Images ({uploadedImages.length})</h3>
									<div class="grid grid-cols-4 gap-4">
										{#each uploadedImages as image}
											<img src={image.url} alt="Patient" class="w-full h-24 object-cover rounded-lg border border-gray-200" />
										{/each}
									</div>
								</div>
							{/if}

							{#if audioRecording}
								<div>
									<h3 class="font-bold text-gray-900 mb-2">Voice Recording</h3>
									<audio controls src={audioRecording.url} class="w-full"></audio>
								</div>
							{/if}
						</div>

						<div class="flex gap-4 mt-8">
							<button
								onclick={submitCase}
								disabled={submitting}
								class="flex-1 bg-green-600 text-white px-6 py-4 rounded-lg font-semibold hover:bg-green-700 disabled:opacity-50 transition-all shadow-lg"
							>
								{submitting ? 'Submitting...' : 'Submit Case'}
							</button>
							<button
								onclick={resetForm}
								class="px-6 py-4 border border-gray-300 rounded-lg font-semibold hover:bg-gray-50 transition-colors"
							>
								New Assessment
							</button>
						</div>
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	@keyframes bounce {
		0%, 100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-0.5rem);
		}
	}
	.animate-bounce {
		animation: bounce 1s infinite;
	}
</style>
