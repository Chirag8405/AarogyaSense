import { json, type RequestEvent } from '@sveltejs/kit';
import prisma from '$lib/server/prisma';
import { verifyToken } from '$lib/server/auth';

// Extract token from Authorization header
function extractToken(request: Request): string | null {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return null;
	}
	return authHeader.substring(7);
}

// GET /api/users - List users with optional role filter
export const GET = async ({ request, url }: RequestEvent) => {
	try {
		// Verify authentication
		const token = extractToken(request);
		if (!token) {
			return json({ error: 'Unauthorized' }, { status: 401 });
		}

		const payload = verifyToken(token);
		if (!payload) {
			return json({ error: 'Invalid token' }, { status: 401 });
		}

		// Get query parameters
		const role = url.searchParams.get('role');
		const location = url.searchParams.get('location');

		// Build where clause
		const where: any = {};

		if (role) {
			where.role = role;
		}

		if (location) {
			where.location = {
				contains: location,
				mode: 'insensitive'
			};
		}

		// Fetch users
		const users = await prisma.user.findMany({
			where,
			select: {
				id: true,
				name: true,
				email: true,
				role: true,
				location: true,
				phone: true
			},
			orderBy: {
				name: 'asc'
			}
		});

		return json({ users });
	} catch (error) {
		console.error('Failed to list users:', error);
		return json({ error: 'Internal Server Error' }, { status: 500 });
	}
};
