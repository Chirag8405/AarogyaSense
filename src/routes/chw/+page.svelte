<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { _, locale } from 'svelte-i18n';
	import { authStore } from '$lib/stores/auth-store';
	import { apiClient } from '$lib/api-client';
	import { get } from 'svelte/store';
	import {
		initializeSocket,
		subscribeToCaseUpdates,
		disconnectSocket
	} from '$lib/stores/socket-store';

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

	// Voice Input State
	let isListening = false;
	let speechRecognition: any = null;
	let voiceSupported = false;

	// Diagnosis Result
	let diagnosisResult = {
		priority: 0,
		riskLevel: 'LOW' as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
		riskScore: 0,
		symptoms: [] as string[],
		recommendations: '',
		needsEscalation: false,
		escalateTo: '' as 'ASHA' | 'CLINICIAN' | '',
		summary: '',
		possibleDiagnosis: ''
	};

	// Demo ASHA Workers
	const nearbyAshaWorkers = [
		{ name: 'Anita Sharma', location: 'Village A (2 km)', phone: '+919876543210' },
		{ name: 'Priya Devi', location: 'Village B (3 km)', phone: '+919876543211' },
		{ name: 'Sunita Kumari', location: 'Village C (5 km)', phone: '+919876543212' }
	];

	// Voice Input Functions
	function initSpeechRecognition() {
		const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
		if (SpeechRecognition) {
			voiceSupported = true;
			speechRecognition = new SpeechRecognition();
			speechRecognition.continuous = false;
			speechRecognition.interimResults = true;
			speechRecognition.lang = 'en-IN';

			speechRecognition.onresult = (event: any) => {
				let transcript = '';
				for (let i = event.resultIndex; i < event.results.length; i++) {
					transcript += event.results[i][0].transcript;
				}
				userInput = transcript;
			};

			speechRecognition.onend = () => {
				isListening = false;
			};

			speechRecognition.onerror = (event: any) => {
				console.error('Speech recognition error:', event.error);
				isListening = false;
			};
		}
	}

	function toggleVoiceInput() {
		if (!speechRecognition) {
			initSpeechRecognition();
		}

		if (!speechRecognition) {
			alert('Voice input is not supported in your browser. Please use Chrome or Edge.');
			return;
		}

		if (isListening) {
			speechRecognition.stop();
			isListening = false;
		} else {
			try {
				speechRecognition.start();
				isListening = true;
			} catch (error) {
				console.error('Failed to start speech recognition:', error);
			}
		}
	}

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

			// Get current language
			const currentLocale = get(locale) || 'en';

			// Call backend AI API
			const response = await fetch('/api/ai/chat', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					messages: [
						{
							role: 'user',
							content: enhancedMessage
						},
						...conversationHistory
					],
					patientInfo: {
						name: patientName,
						age: patientAge,
						gender: patientGender,
						village: patientVillage,
						hasImages: uploadedImages.length > 0,
						hasAudio: audioRecording !== null
					},
					language: currentLocale
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

			// Add AI message to UI (only if not JSON format)
			if (!data.assessment_complete) {
				addMessage('ai', data.message);
			} else if (data.message) {
				// For final assessment, show only the text part (remove JSON)
				const cleanMessage = data.message.split('{')[0].trim();
				if (cleanMessage) {
					addMessage('ai', cleanMessage);
				}
			}

			// Check if diagnosis is complete
			if (data.assessment_complete && data.assessment) {
				diagnosisComplete = true;
				const assessment = data.assessment;

				// Clean summary by removing JSON block if present
				let cleanSummary = assessment.summary || data.message || '';

				// Remove JSON block from summary
				if (cleanSummary.includes('{')) {
					const textBeforeJson = cleanSummary.split('{')[0].trim();
					cleanSummary = textBeforeJson;
				}

				// Remove generic/useless phrases and partial sentences
				const genericPhrases = [
					'Here is the assessment:',
					'Here is the diagnosis:',
					'Assessment:',
					'Diagnosis:',
					'Based on the information provided:',
					"Based on the information you've provided:",
					'Based on your symptoms:',
					'Thank you for the information.',
					'Thank you for providing',
					'Let me assess',
					'I will now',
					'Based on',
					'According to'
				];

				genericPhrases.forEach((phrase) => {
					if (cleanSummary.toLowerCase().includes(phrase.toLowerCase())) {
						cleanSummary = cleanSummary.replace(new RegExp(phrase, 'gi'), '').trim();
					}
				});

				// Remove leading/trailing punctuation and check if meaningful
				cleanSummary = cleanSummary.replace(/^[,.\-:\s]+|[,.\-:\s]+$/g, '').trim();

				// If summary is now empty, too short (< 30 chars), or just punctuation
				// use possible_diagnosis or create summary
				const hasLetters = /[a-zA-Z]{3,}/.test(cleanSummary);
				if (!cleanSummary || cleanSummary.length < 30 || !hasLetters) {
					if (assessment.possible_diagnosis) {
						cleanSummary = assessment.possible_diagnosis;
					} else {
						cleanSummary = `Assessment completed for ${patientName}. Risk level: ${assessment.risk_level}. ${assessment.recommendations}`;
					}
				}

				diagnosisResult = {
					priority: assessment.priority || 0,
					riskLevel: assessment.risk_level || 'LOW',
					riskScore: assessment.risk_score || 0,
					symptoms: assessment.symptoms || [],
					recommendations: assessment.recommendations || '',
					needsEscalation: assessment.needs_escalation || false,
					escalateTo: assessment.escalate_to || '',
					summary: cleanSummary,
					possibleDiagnosis: assessment.possible_diagnosis || ''
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
		addMessage(
			'ai',
			`Hello! I'm your AI health assistant. Let's assess ${patientName}'s condition together. I'll ask you a few questions to understand the situation better.`
		);

		// Start conversation with AI
		setTimeout(async () => {
			await callAI(
				"Please start the health assessment. Ask your first question about the patient's condition."
			);
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
			const imageUrls = uploadedImages.map((img) => img.url);

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

	// Format diagnosis text to make disease names bold
	function formatDiagnosisHTML(text: string): string {
		// Common disease/condition patterns to bold
		const patterns = [
			// Disease names
			/\b(viral fever|bacterial infection|dengue fever|malaria|typhoid|tuberculosis|pneumonia|bronchitis|asthma|hepatitis [A-Z]|jaundice|gastroenteritis|dysentery|cholera|diarrhea|food poisoning|dehydration|hypertension|diabetes|heart attack|cardiac event|stroke|sepsis|meningitis|encephalitis|covid-19|influenza|common cold|urinary tract infection|kidney infection|appendicitis)\b/gi,
			// Condition patterns
			/\b(acute respiratory distress|respiratory infection|gastrointestinal infection|cardiac arrhythmia|myocardial infarction|acute coronary syndrome|liver involvement|waterborne disease|vector-borne disease)\b/gi
		];

		let formatted = text;
		patterns.forEach((pattern) => {
			formatted = formatted.replace(pattern, '<strong class="text-blue-900">$&</strong>');
		});

		return formatted;
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
			summary: '',
			possibleDiagnosis: ''
		};
	}

	let unsubscribe: (() => void) | undefined;

	onMount(() => {
		const state = get(authStore);
		if (!state.isAuthenticated) {
			goto('/auth', { replaceState: true });
			return;
		}

		const allowedRoles = ['CHW', 'ASHA', 'ASHA_SUPERVISOR', 'CLINICIAN', 'DOCTOR', 'ADMIN'];
		if (!allowedRoles.includes(state.user?.role || '')) {
			unauthorized = true;
			return;
		}

		// Initialize WebSocket connection
		initializeSocket();

		// Subscribe to real-time case updates
		unsubscribe = subscribeToCaseUpdates((data) => {
			console.log('Received case update:', data);
			// You can add notification or UI feedback here if needed
		});
	});

	onDestroy(() => {
		// Clean up WebSocket subscription
		if (unsubscribe) {
			unsubscribe();
		}
		disconnectSocket();
	});
</script>

{#if unauthorized}
	<div class="flex min-h-screen items-center justify-center bg-background p-4">
		<div class="max-w-md w-full bg-surface rounded-lg shadow-lg p-8 text-center">
			<div class="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
				<svg class="w-10 h-10 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
					/>
				</svg>
			</div>
			<h2 class="text-2xl font-bold text-surface-emphasis mb-3">Access Denied</h2>
			<p class="text-muted mb-6">You don't have permission to access this page.</p>
			<a
				href="/"
				class="block w-full bg-brand text-white px-6 py-3 rounded-lg font-semibold hover:bg-brand/90 transition-colors"
			>
				Return to Home
			</a>
		</div>
	</div>
{:else}
	<div class="min-h-screen bg-background">
		<!-- Header -->
		<header class="bg-surface shadow-sm border-b border-border/50 sticky top-0 z-50 backdrop-blur-md bg-surface/90">
			<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
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
						<h1 class="text-xl font-bold text-surface-emphasis">{$_('chw.aiHealthAssessment')}</h1>
						<p class="text-sm text-muted">{$_('chw.intelligentSupport')}</p>
					</div>
				</div>
				<div class="flex items-center gap-3">
					<div class="hidden md:block text-right">
						<p class="text-sm font-bold text-surface-emphasis">{$authStore.user?.name}</p>
						<p class="text-xs text-muted">Community Health Worker</p>
					</div>
					<div class="h-10 w-10 rounded-full bg-brand/10 flex items-center justify-center text-brand font-bold border border-brand/20">
						{$authStore.user?.name?.charAt(0) || 'C'}
					</div>
				</div>
			</div>
		</header>

		<div class="max-w-7xl mx-auto p-4 py-8">
			{#if showPatientForm}
				<!-- Patient Information Form -->
				<div class="bg-surface rounded-xl shadow-sm border border-border/50 p-8">
					<h2 class="text-2xl font-bold text-surface-emphasis mb-6">Patient Information</h2>

					<div class="space-y-6">
						<div class="grid grid-cols-1 md:grid-cols-2 gap-6">
							<div>
								<label for="patientName" class="block text-sm font-medium text-surface-emphasis mb-2"
									>{$_('chw.patientName')} *</label
								>
								<input
									id="patientName"
									type="text"
									bind:value={patientName}
									placeholder={$_('chw.patientNamePlaceholder')}
									class="w-full px-4 py-3 bg-surface-soft border border-border rounded-lg focus:ring-2 focus:ring-brand focus:border-transparent transition-all"
								/>
							</div>

							<div>
								<label for="patientAge" class="block text-sm font-medium text-surface-emphasis mb-2">{$_('chw.age')} *</label
								>
								<input
									id="patientAge"
									type="number"
									bind:value={patientAge}
									placeholder={$_('chw.agePlaceholder')}
									min="0"
									max="120"
									class="w-full px-4 py-3 bg-surface-soft border border-border rounded-lg focus:ring-2 focus:ring-brand focus:border-transparent transition-all"
								/>
							</div>
						</div>

						<div class="grid grid-cols-1 md:grid-cols-2 gap-6">
							<div>
								<label for="patientGender" class="block text-sm font-medium text-surface-emphasis mb-2"
									>{$_('chw.gender')} *</label
								>
								<select
									id="patientGender"
									bind:value={patientGender}
									class="w-full px-4 py-3 bg-surface-soft border border-border rounded-lg focus:ring-2 focus:ring-brand focus:border-transparent transition-all"
								>
									<option value="MALE">{$_('chw.male')}</option>
									<option value="FEMALE">{$_('chw.female')}</option>
									<option value="OTHER">{$_('chw.other')}</option>
								</select>
							</div>

							<div>
								<label for="patientPhone" class="block text-sm font-medium text-surface-emphasis mb-2"
									>{$_('chw.phoneNumber')}</label
								>
								<input
									id="patientPhone"
									type="tel"
									bind:value={patientPhone}
									placeholder={$_('chw.phoneNumberPlaceholder')}
									class="w-full px-4 py-3 bg-surface-soft border border-border rounded-lg focus:ring-2 focus:ring-brand focus:border-transparent transition-all"
								/>
							</div>
						</div>

						<div>
							<label for="patientVillage" class="block text-sm font-medium text-surface-emphasis mb-2">{$_('chw.village')}</label
							>
							<input
								id="patientVillage"
								type="text"
								bind:value={patientVillage}
								placeholder={$_('chw.villagePlaceholder')}
								class="w-full px-4 py-3 bg-surface-soft border border-border rounded-lg focus:ring-2 focus:ring-brand focus:border-transparent transition-all"
							/>
						</div>

						<!-- Image Upload -->
						<div>
							<label for="image-upload" class="block text-sm font-medium text-surface-emphasis mb-2"
								>{$_('chw.imageUploadLabel')} ({$_('chw.optional')})</label
							>
							<div
								class="border-2 border-dashed border-border rounded-lg p-6 text-center hover:border-brand transition-colors bg-surface-soft/30"
							>
								<input
									type="file"
									accept="image/*"
									multiple
									onchange={handleImageUpload}
									class="hidden"
									id="image-upload"
								/>
								<label for="image-upload" class="cursor-pointer">
									<svg
										class="w-12 h-12 text-muted mx-auto mb-2"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
										/>
									</svg>
									<p class="text-sm text-muted">{$_('chw.patientInfo')}</p>
									<p class="text-xs text-muted mt-1">{$_('chw.patientInfo')}</p>
								</label>

								{#if uploadedImages.length > 0}
									<div class="mt-4 grid grid-cols-3 gap-4">
										{#each uploadedImages as image, index}
											<div class="relative group">
												<img
													src={image.url}
													alt="Patient"
													class="w-full h-32 object-cover rounded-lg"
												/>
												<button
													onclick={() => removeImage(index)}
													aria-label="Remove image"
													class="absolute top-2 right-2 bg-red-500 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
												>
													<svg
														class="w-4 h-4"
														fill="none"
														stroke="currentColor"
														viewBox="0 0 24 24"
													>
														<path
															stroke-linecap="round"
															stroke-linejoin="round"
															stroke-width="2"
															d="M6 18L18 6M6 6l12 12"
														/>
													</svg>
												</button>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						</div>

						<!-- Voice Recording -->
						<div>
							<p class="block text-sm font-medium text-surface-emphasis mb-2"
								>{$_('chw.voiceNote')} ({$_('chw.optional')})</p
							>
							<div class="border border-border rounded-lg p-4">
								{#if !audioRecording}
									{#if !isRecording}
										<button
											onclick={startRecording}
											class="w-full bg-blue-500/10 hover:bg-blue-500/20 text-blue-600 py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
										>
											<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
												/>
											</svg>
											{$_('chw.recordVoice')}
										</button>
										<p class="text-xs text-muted mt-2 text-center">{$_('chw.voiceHelp')}</p>
									{:else}
										<button
											onclick={stopRecording}
											class="w-full bg-red-500 hover:bg-red-600 text-white py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 animate-pulse"
										>
											<div class="w-3 h-3 bg-white rounded-full"></div>
											{$_('chw.recording')}
										</button>
									{/if}
								{:else}
									<div class="flex items-center justify-between bg-green-500/10 p-3 rounded-lg">
										<div class="flex items-center gap-3">
											<svg
												class="w-8 h-8 text-brand"
												fill="none"
												stroke="currentColor"
												viewBox="0 0 24 24"
											>
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
												/>
											</svg>
											<div>
												<p class="font-medium text-surface-emphasis">{$_('chw.voiceCaptured')}</p>
												<audio controls src={audioRecording.url} class="mt-2 h-8"></audio>
											</div>
										</div>
										<button onclick={removeAudio} aria-label="Remove audio" class="text-red-600 hover:text-red-700">
											<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
												/>
											</svg>
										</button>
									</div>
								{/if}
							</div>
						</div>

						<!-- Nearby ASHA Workers Info -->
						<div class="bg-blue-500/10 border border-blue-200 rounded-lg p-4">
							<h3 class="font-medium text-blue-700 mb-2">{$_('chw.nearbyAshaWorkers')}</h3>
							<div class="space-y-2">
								{#each nearbyAshaWorkers as worker}
									<div class="flex justify-between text-sm">
										<span class="text-blue-700">{worker.name}</span>
										<span class="text-blue-500">{worker.location}</span>
									</div>
								{/each}
							</div>
							<p class="text-xs text-blue-600 mt-2">{$_('chw.highRiskAlert')}</p>
						</div>
					</div>

					<button
						onclick={startDiagnosis}
						disabled={!patientName || !patientAge || !patientGender}
						class="w-full mt-6 bg-brand text-white px-6 py-4 rounded-lg font-semibold hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg"
					>
						{$_('chw.startAssessment')}
					</button>
				</div>
			{:else if !diagnosisComplete}
				<!-- Chat Interface -->
				<div class="bg-surface rounded-lg shadow-lg overflow-hidden">
					<!-- Chat Header -->
					<div class="bg-brand text-white p-6">
						<div class="flex items-center justify-between">
							<div>
								<h3 class="font-bold text-lg">AI Health Assistant</h3>
								<p class="text-sm text-white/90">
									Assessing {patientName}, {patientAge} years, {patientGender}
								</p>
							</div>
							<div class="text-right">
								<p class="text-xs text-white/80">Questions asked</p>
								<p class="text-2xl font-bold">{questionCount}</p>
							</div>
						</div>
					</div>

					<!-- Chat Messages -->
					<div id="chat-container" class="h-[500px] overflow-y-auto p-6 space-y-4 bg-background">
						{#each messages as message}
							<div class="flex {message.role === 'ai' ? 'justify-start' : 'justify-end'}">
								<div
									class="max-w-[80%] {message.role === 'ai'
										? 'bg-surface border border-border'
										: 'bg-brand text-white'} rounded-lg p-4 shadow-sm"
								>
									{#if message.role === 'ai'}
										<div class="flex items-start gap-3">
											<div
												class="w-8 h-8 bg-brand/10 rounded-full flex items-center justify-center flex-shrink-0"
											>
												<svg
													class="w-5 h-5 text-brand"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
													/>
												</svg>
											</div>
											<div class="flex-1">
												<p class="text-sm font-medium text-surface-emphasis mb-1">AI Assistant</p>
												<p class="text-surface-emphasis whitespace-pre-wrap">{message.text}</p>
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
								<div class="bg-surface border border-border rounded-lg p-4 shadow-sm">
									<div class="flex items-center gap-2">
										<div class="flex gap-1">
											<div class="w-2 h-2 bg-brand rounded-full animate-bounce"></div>
											<div
												class="w-2 h-2 bg-brand rounded-full animate-bounce"
												style="animation-delay: 0.2s"
											></div>
											<div
												class="w-2 h-2 bg-brand rounded-full animate-bounce"
												style="animation-delay: 0.4s"
											></div>
										</div>
										<span class="text-sm text-muted">AI is thinking...</span>
									</div>
								</div>
							</div>
						{/if}
					</div>

					<!-- Input Area -->
					<div class="border-t p-4 bg-surface">
						{#if setupError}
							<div class="mb-4 bg-red-500/10 border border-red-200 text-red-600 px-4 py-3 rounded-lg">
								<p class="font-medium">Configuration Error</p>
								<p class="text-sm">{setupError}</p>
							</div>
						{/if}

						<div class="flex gap-2">
							<input
								type="text"
								bind:value={userInput}
								onkeydown={(e) => e.key === 'Enter' && handleSendMessage()}
								disabled={!awaitingResponse || aiThinking}
								placeholder={awaitingResponse
									? (isListening ? 'Listening... speak now' : 'Type or tap mic to speak...')
									: 'Please wait for AI question...'}
								class="flex-1 px-4 py-3 border border-border rounded-lg focus:ring-2 focus:ring-brand focus:border-transparent disabled:bg-surface-soft {isListening ? 'border-red-500 ring-2 ring-red-200' : ''}"
							/>
							<!-- Voice Input Button -->
							<button
								type="button"
								onclick={toggleVoiceInput}
								disabled={!awaitingResponse || aiThinking}
								title={isListening ? 'Stop listening' : 'Start voice input'}
								class="px-4 py-3 rounded-lg font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center
									{isListening ? 'bg-red-500 text-white animate-pulse' : 'bg-gray-200 text-gray-700 hover:bg-brand/10 hover:text-brand'}"
							>
								<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>
								</svg>
							</button>
							<button
								onclick={handleSendMessage}
								disabled={!awaitingResponse || aiThinking || !userInput.trim()}
								class="bg-brand text-white px-6 py-3 rounded-lg font-medium hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
							>
								Send
							</button>
						</div>
					</div>
				</div>
			{:else}
				<!-- Diagnosis Result -->
				<div class="space-y-6">
					<!-- FEATURED: Recommendations Card - MOST IMPORTANT -->
					<div class="bg-surface border-2 border-brand rounded-lg shadow-lg p-6">
						<div class="flex items-start gap-4 mb-4">
							<div
								class="w-12 h-12 bg-brand rounded-lg flex items-center justify-center flex-shrink-0"
							>
								<svg
									class="w-7 h-7 text-white"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
									/>
								</svg>
							</div>
							<div class="flex-1">
								<h2 class="text-xl font-bold text-surface-emphasis mb-1">Recommended Action</h2>
								<p class="text-sm text-muted">What you should do for this patient</p>
							</div>
						</div>

						<div class="bg-brand/5 border-l-4 border-brand rounded p-5">
							<p class="text-base leading-relaxed text-surface-emphasis">
								{diagnosisResult.recommendations}
							</p>
						</div>

						{#if diagnosisResult.needsEscalation}
							<div
								class="mt-4 bg-orange-500/10 border-l-4 border-orange-500 rounded p-4 flex items-start gap-3"
							>
								<svg
									class="w-6 h-6 flex-shrink-0 text-orange-600"
									fill="currentColor"
									viewBox="0 0 20 20"
								>
									<path
										fill-rule="evenodd"
										d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
									/>
								</svg>
								<div>
									<p class="font-semibold text-orange-700 mb-1">Escalation Required</p>
									<p class="text-sm text-orange-600">
										This case will be automatically forwarded to <span class="font-semibold"
											>{diagnosisResult.escalateTo}</span
										> for review
									</p>
								</div>
							</div>
						{/if}
					</div>

					<!-- Risk Assessment -->
					<div class="bg-surface rounded-lg shadow-lg p-6">
						<h3 class="text-lg font-bold text-surface-emphasis mb-4 flex items-center gap-2">
							<svg
								class="w-5 h-5 text-muted"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
								/>
							</svg>
							Risk Assessment
						</h3>

						<div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
							<!-- Risk Level -->
							<div
								class="border-2 rounded-lg p-4 text-center
								{diagnosisResult.riskLevel === 'CRITICAL' ? 'border-red-600 bg-red-500/10' : ''}
								{diagnosisResult.riskLevel === 'HIGH' ? 'border-orange-500 bg-orange-500/10' : ''}
								{diagnosisResult.riskLevel === 'MEDIUM' ? 'border-yellow-500 bg-yellow-500/10' : ''}
								{diagnosisResult.riskLevel === 'LOW' ? 'border-brand bg-brand/5' : ''}"
							>
								<p class="text-xs text-muted mb-1">Risk Level</p>
								<p
									class="text-xl font-bold
									{diagnosisResult.riskLevel === 'CRITICAL' ? 'text-red-600' : ''}
									{diagnosisResult.riskLevel === 'HIGH' ? 'text-orange-600' : ''}
									{diagnosisResult.riskLevel === 'MEDIUM' ? 'text-yellow-600' : ''}
									{diagnosisResult.riskLevel === 'LOW' ? 'text-brand' : ''}"
								>
									{diagnosisResult.riskLevel}
								</p>
							</div>

							<!-- Risk Score -->
							<div class="border-2 border-border bg-surface-soft rounded-lg p-4 text-center">
								<p class="text-xs text-muted mb-1">Risk Score</p>
								<p class="text-2xl font-bold text-surface-emphasis">
									{diagnosisResult.riskScore}<span class="text-sm text-muted">/100</span>
								</p>
							</div>

							<!-- Priority -->
							<div class="border-2 border-border bg-surface-soft rounded-lg p-4 text-center">
								<p class="text-xs text-muted mb-1">Priority</p>
								<p class="text-2xl font-bold text-surface-emphasis">
									{diagnosisResult.priority}<span class="text-sm text-muted">/5</span>
								</p>
							</div>
						</div>

						<!-- Progress Bar -->
						<div class="bg-surface-soft rounded-lg p-3">
							<p class="text-xs font-medium text-muted mb-2">Risk Severity Indicator</p>
							<div class="w-full bg-border rounded-full h-4 overflow-hidden">
								<div
									class="h-full rounded-full transition-all duration-1000 flex items-center justify-end pr-2
									{diagnosisResult.riskLevel === 'CRITICAL' ? 'bg-red-600' : ''}
									{diagnosisResult.riskLevel === 'HIGH' ? 'bg-orange-500' : ''}
									{diagnosisResult.riskLevel === 'MEDIUM' ? 'bg-yellow-500' : ''}
									{diagnosisResult.riskLevel === 'LOW' ? 'bg-brand' : ''}"
									style="width: {diagnosisResult.riskScore}%"
								>
									<span class="text-white text-xs font-semibold">{diagnosisResult.riskScore}%</span>
								</div>
							</div>
						</div>
					</div>

					<!-- Symptoms -->
					<div class="bg-surface rounded-lg shadow-lg p-6">
						<h3 class="text-lg font-bold text-surface-emphasis mb-4 flex items-center gap-2">
							<svg
								class="w-5 h-5 text-muted"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
								/>
							</svg>
							Identified Symptoms
						</h3>
						<div class="flex flex-wrap gap-2">
							{#each diagnosisResult.symptoms as symptom}
								<span
									class="inline-flex items-center bg-surface-soft text-surface-emphasis px-3 py-1.5 rounded-md text-sm font-medium border border-border"
								>
									{symptom}
								</span>
							{/each}
						</div>
					</div>

					<!-- Possible Diagnosis -->
					{#if diagnosisResult.possibleDiagnosis && diagnosisResult.possibleDiagnosis.trim()}
						<div class="bg-surface rounded-lg shadow-lg p-6 border-l-4 border-blue-500">
							<h3 class="text-lg font-bold text-surface-emphasis mb-4 flex items-center gap-2">
								<svg
									class="w-5 h-5 text-blue-500"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
									/>
								</svg>
								Possible Diagnosis
							</h3>
							<div class="bg-blue-500/10 border border-blue-200 rounded-lg p-4">
								<p class="text-surface-emphasis leading-relaxed font-medium">
									{@html formatDiagnosisHTML(diagnosisResult.possibleDiagnosis)}
								</p>
							</div>
						</div>
					{/if}

					<!-- Assessment Summary -->
					{#if diagnosisResult.summary && diagnosisResult.summary.trim() && diagnosisResult.summary.length >= 30 && !/^(based on|according to|here is|thank you)/i.test(diagnosisResult.summary.trim())}
						<div class="bg-surface rounded-lg shadow-lg p-6">
							<h3 class="text-lg font-bold text-surface-emphasis mb-4 flex items-center gap-2">
								<svg
									class="w-5 h-5 text-muted"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
									/>
								</svg>
								Assessment Details
							</h3>
							<div class="bg-surface-soft border border-border rounded-lg p-4">
								<p class="text-surface-emphasis leading-relaxed">{diagnosisResult.summary}</p>
							</div>
						</div>
					{/if}

					<!-- Media Attachments -->
					{#if uploadedImages.length > 0 || audioRecording}
						<div class="bg-surface rounded-lg shadow-lg p-6">
							<h3 class="text-lg font-bold text-surface-emphasis mb-4 flex items-center gap-2">
								<svg
									class="w-5 h-5 text-muted"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
									/>
								</svg>
								Attachments
							</h3>

							{#if uploadedImages.length > 0}
								<div class="mb-4">
									<p class="text-sm font-medium text-surface-emphasis mb-3">
										Patient Images ({uploadedImages.length})
									</p>
									<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
										{#each uploadedImages as image}
											<img
												src={image.url}
												alt="Patient"
												class="w-full h-28 object-cover rounded-lg border border-border"
											/>
										{/each}
									</div>
								</div>
							{/if}

							{#if audioRecording}
								<div>
									<p class="text-sm font-medium text-surface-emphasis mb-3">Voice Recording</p>
									<audio controls src={audioRecording.url} class="w-full"></audio>
								</div>
							{/if}
						</div>
					{/if}

					<!-- Action Buttons -->
					<div class="bg-surface rounded-lg shadow-lg p-6">
						<div class="flex flex-col sm:flex-row gap-3">
							<button
								onclick={submitCase}
								disabled={submitting}
								class="flex-1 bg-brand text-white px-6 py-3 rounded-lg font-semibold hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
							>
								{#if submitting}
									<svg class="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
										<circle
											class="opacity-25"
											cx="12"
											cy="12"
											r="10"
											stroke="currentColor"
											stroke-width="4"
										></circle>
										<path
											class="opacity-75"
											fill="currentColor"
											d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
										></path>
									</svg>
									Submitting Case...
								{:else}
									<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
										/>
									</svg>
									Submit Case
								{/if}
							</button>
							<button
								onclick={resetForm}
								class="px-6 py-3 border-2 border-border rounded-lg font-semibold text-surface-emphasis hover:bg-surface-soft transition-colors flex items-center justify-center gap-2"
							>
								<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
									/>
								</svg>
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
		0%,
		100% {
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
