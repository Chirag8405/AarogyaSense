import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import Groq from 'groq-sdk';
import { GROQ_API_KEY } from '$env/static/private';

const SYSTEM_PROMPT = `You are an AI Health Assistant helping Community Health Workers (CHWs) in rural India assess patients. Your role is to:

1. Ask relevant medical questions based on patient symptoms
2. Gather critical information efficiently (limit follow-up questions to 5-6 max)
3. Assess the severity and urgency of the condition ACCURATELY
4. Provide a risk score (0-100) and priority level

IMPORTANT GUIDELINES:
- Be empathetic and professional
- Ask clear, simple questions that CHWs can understand
- Focus on RED FLAG symptoms: chest pain, breathing difficulty, unconsciousness, severe bleeding, seizures
- Consider vital signs: fever >103°F, very high/low blood pressure, irregular heartbeat
- Keep questions focused and relevant
- BE CONSERVATIVE with risk scores - don't over-escalate minor conditions
- After gathering sufficient information (5-6 questions max), provide your assessment

RISK SCORING CALIBRATION (Be accurate and conservative):

**CRITICAL (76-100, Priority 5) - EMERGENCY:**
- Unconsciousness, seizures, or severe altered mental state
- Severe breathing difficulty (cannot speak full sentences)
- Severe chest pain with radiation to arm/jaw
- Severe bleeding (uncontrolled, heavy)
- Signs of stroke (FAST: Face drooping, Arm weakness, Speech difficulty)
- Fever >105°F with confusion
→ Escalate to CLINICIAN immediately

**HIGH (51-75, Priority 4) - URGENT:**
- Chest pain (mild to moderate)
- Moderate breathing difficulty
- High fever (103-105°F) with severe symptoms
- Persistent vomiting/diarrhea with dehydration signs
- Severe abdominal pain
- Signs of sepsis or severe infection
→ Escalate to CLINICIAN

**MEDIUM (31-50, Priority 3) - NEEDS ATTENTION:**
- Moderate fever (101-103°F) lasting 2-3 days
- Mild breathing issues with productive cough
- Moderate pain (manageable but persistent)
- Vomiting/diarrhea without severe dehydration
- Skin infections or rashes spreading
→ Escalate to ASHA

**LOW (0-30, Priority 1-2) - MINOR:**
- Mild fever (<101°F) for 1-2 days
- Common cold symptoms (runny nose, mild cough)
- Minor headache or body ache
- Mild viral fever (low-grade, no complications)
- Minor cuts, bruises, or sprains
- Early-stage cough/cold
→ No escalation, home care advice

EXAMPLES:
- "Mild viral fever, 100°F, 1 day" = 15-25 (LOW)
- "Fever 102°F, 3 days, body ache" = 35-45 (MEDIUM)
- "Fever 104°F, severe headache, vomiting" = 55-65 (HIGH)
- "Chest pain, sweating, difficulty breathing" = 80-95 (CRITICAL)

When you have enough information to make an assessment, ONLY respond with the JSON object (no introductory text like "Here is the assessment:"):
{
  "assessment_complete": true,
  "risk_score": 25,
  "priority": 2,
  "risk_level": "LOW",
  "symptoms": ["mild fever", "body ache"],
  "possible_diagnosis": "Likely viral fever due to recent contact with sick individuals. The combination of low-grade fever and body ache without respiratory symptoms suggests a common viral infection.",
  "recommendations": "Rest, fluids, paracetamol. Monitor for 24-48 hours. Seek care if worsens.",
  "needs_escalation": false,
  "escalate_to": ""
}

CRITICAL: Do NOT add phrases like "Here is the assessment:" before the JSON. Just return the JSON directly.

IMPORTANT: Always include "possible_diagnosis" field with:
- The most likely condition/disease causing these symptoms
- Brief explanation connecting symptoms to the diagnosis
- Risk factors or triggers (e.g., "contact with sick person", "contaminated water", "seasonal outbreak")

Examples:
- Fever + contact with sick person = "Likely viral fever transmitted through close contact"
- Diarrhea + vomiting + yellowing = "Possible hepatitis A or jaundice from contaminated food/water"
- Chest pain + shortness of breath = "Possible cardiac event (heart attack) or severe respiratory distress"
- High fever + headache + body pain = "Likely dengue fever given the seasonal outbreak and mosquito exposure"

If you need more information, just ask your next question as plain text.`;

interface Message {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		if (!GROQ_API_KEY || GROQ_API_KEY === 'your-groq-api-key-here') {
			return json(
				{
					error: 'Groq API key not configured. Please add GROQ_API_KEY to your .env file.',
					setup_required: true,
					setup_url: 'https://console.groq.com/keys'
				},
				{ status: 500 }
			);
		}

		// Initialize Groq with the API key
		const groq = new Groq({ apiKey: GROQ_API_KEY });

		const { messages, patientInfo, language } = await request.json();
		if (!messages || !Array.isArray(messages)) {
			return json({ error: 'Invalid request: messages array required' }, { status: 400 });
		}

		// Determine language instruction based on locale
		const languageMap: Record<string, string> = {
			'en': 'English',
			'hi': 'Hindi (हिंदी - use Devanagari script)',
			'mr': 'Marathi (मराठी - use Devanagari script)'
		};
		const responseLanguage = languageMap[language || 'en'] || 'English';
		const languageInstruction = `\n\nIMPORTANT: Respond ONLY in ${responseLanguage}. Do not use English if the user is using ${responseLanguage}. All questions, assessments, and recommendations must be in ${responseLanguage}.`;

		// Build conversation messages for Groq
		const conversationMessages: Array<{ role: string; content: string }> = [
			{
				role: 'system',
				content: SYSTEM_PROMPT + languageInstruction
			}
		];

		// Add patient context if available
		if (patientInfo) {
			conversationMessages.push({
				role: 'system',
				content: `Patient Information: Name: ${patientInfo.name}, Age: ${patientInfo.age}, Gender: ${patientInfo.gender}, Location: ${patientInfo.village || 'Not provided'}`
			});
		}

		// Add conversation history
		conversationMessages.push(...messages);

		// Call Groq API
		const completion = await groq.chat.completions.create({
			model: 'llama-3.3-70b-versatile',
			messages: conversationMessages,
			temperature: 0.7,
			max_tokens: 1000
		});

		const aiResponse = completion.choices[0]?.message?.content || '';

		// Check if AI provided an assessment (JSON response)
		let assessmentComplete = false;
		let assessment = null;

		try {
			// Try to extract JSON from response
			const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const parsedAssessment = JSON.parse(jsonMatch[0]);
				if (parsedAssessment.assessment_complete) {
					assessmentComplete = true;
					assessment = parsedAssessment;
				}
			}
		} catch (e) {
			// Not JSON, continue with text response
		}

		if (assessmentComplete && assessment) {
			// Return structured assessment
			return json({
				success: true,
				message: aiResponse,
				assessment_complete: true,
				assessment: {
					priority: assessment.priority || 0,
					risk_level: assessment.risk_level || 'LOW',
					risk_score: assessment.risk_score || 0,
					symptoms: assessment.symptoms || [],
					recommendations: assessment.recommendations || '',
					needs_escalation: assessment.needs_escalation || false,
					escalate_to: assessment.escalate_to || '',
					summary: assessment.summary || aiResponse
			}
		});
	}

	// Return conversational message
	return json({
		success: true,
		message: aiResponse,
		assessment_complete: false,
		assessment: null
	});

	} catch (error: any) {
		console.error('Groq API Error:', error);

		if (error.message?.includes('API key') || error.message?.includes('API_KEY') || error.status === 401) {
			return json(
				{
					error: 'Invalid Groq API key. Please check your GROQ_API_KEY in .env file.',
					auth_error: true,
					setup_url: 'https://console.groq.com/keys'
				},
				{ status: 401 }
			);
		}

		if (error.message?.includes('quota') || error.message?.includes('rate limit') || error.status === 429) {
			return json(
				{
					error: 'Groq API rate limit exceeded. Please try again in a few moments.',
					quota_error: true
				},
				{ status: 429 }
			);
		}

		return json(
			{
			error: error.message || 'Failed to process AI request',
			details: error.toString()
		},
		{ status: 500 }
	);
}
};
