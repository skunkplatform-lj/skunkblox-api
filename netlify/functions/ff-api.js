const skunkblox = require("@skunkplatform/skunkblox");

const bestFriends = {
	"5797859201": [
		"2364023926",
		"1487179033",
		"1110672063",
		"4943824163",
		"2240954006",
		"3438496123",
		"1154317855"
	]
};

function json(statusCode, data) {
	return {
		statusCode,
		headers: {
			"Content-Type": "application/json"
		},
		body: JSON.stringify(data)
	};
}

async function sendWebhookRequest(uid, friends) {
	const webhook = process.env.dc;

	if (!webhook) {
		console.warn("[ff-api] Webhook URL is not configured");
		return;
	}

	const response = await fetch(webhook, {
		method: "POST",
		headers: {
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			content:
				`Best Friends request\n` +
				`UID: ${String(uid)}\n` +
				`Friends: ${friends.map(String).join(", ")}`
		})
	});

	const responseBody = await response.text();

	if (!response.ok) {
		console.error("[ff-api] Discord webhook:", response.status, responseBody);
		throw new Error(`Webhook returned ${response.status}`);
	}
}

function getUid(event) {
	const path = event.path || "";
	const parts = path.split("/").filter(Boolean);

	return parts.at(-1);
}

function validUid(uid) {
	return /^\d+$/.test(String(uid));
}

exports.handler = async function (event) {
	try {
		const method = event.httpMethod;
		const path = event.path || "";

		if (method === "GET" && path.includes("/friends/")) {
			const uid = getUid(event);

			if (!validUid(uid)) {
				return json(404, {
					m: "Robloxian Not Found",
					p: "robloxian_not_found"
				});
			}

			const user = await skunkblox.users.getUser(uid);

			if (!user) {
				return json(404, {
					m: "Robloxian Not Found",
					p: "robloxian_not_found"
				});
			}

			const friends = await skunkblox.friends.getFriends(
				uid,
				200
			);

			return json(
				200,
				friends.map(friend => String(friend.id))
			);
		}

		if (method === "GET" && path.includes("/bestfriends/")) {
			const uid = getUid(event);

			if (!validUid(uid)) {
				return json(404, {
					m: "Robloxian Not Found",
					p: "robloxian_not_found"
				});
			}

			const user = await skunkblox.users.getUser(uid);

			if (!user) {
				return json(404, {
					m: "Robloxian Not Found",
					p: "robloxian_not_found"
				});
			}

			return json(
				200,
				bestFriends[uid] || []
			);
		}

		if (
			method === "POST" &&
			path.includes("/bestfriends/request")
		) {
			let body;

			try {
				body = JSON.parse(event.body || "{}");
			} catch {
				return json(400, {
					m: "Invalid JSON",
					p: "invalid_json"
				});
			}

			const uid = String(body.uid || "");
			const friends = body.friends;

			if (!validUid(uid) || !Array.isArray(friends)) {
				return json(400, {
					m: "Invalid Request",
					p: "invalid_request"
				});
			}

			const userFriends =
				await skunkblox.friends.getFriends(uid, 200);

			const friendIds = new Set(
				userFriends.map(friend => String(friend.id))
			);

			const validFriends = friends
				.map(String)
				.filter(friendUid => validUid(friendUid))
				.filter(friendUid => friendIds.has(friendUid));

			bestFriends[uid] = [
				...new Set(validFriends)
			];

			await sendWebhookRequest(
				uid,
				bestFriends[uid]
			);

			return json(200, {
				m: "Best Friends Updated",
				p: "success",
				uid,
				friends: bestFriends[uid]
			});
		}

		return json(404, {
			m: "Route Not Found",
			p: "route_not_found"
		});
	} catch (err) {
		console.error("[ff-api]", err);

		return json(500, {
			m: "[Server]: Internal server error",
			p: "internal_server_fail"
		});
	}
};
