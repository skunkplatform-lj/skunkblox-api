// netlify/functions/catalog-api.js

const ROBLOX_CATALOG_API = "https://catalog.roblox.com/v1";
const REVIEW_WEBHOOK_URL = process.env.dc1;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

// Roblox's documented Marketplace limits are currently more restrictive
// than SkunkBlox's public 50-item page size.
// We fetch multiple Roblox pages when necessary.
const ROBLOX_PAGE_LIMIT = 30;

const ACCESS_CONTROL_ALLOW_ORIGIN =
    process.env.CATALOG_CORS_ORIGIN || "*";

const ACCESSORY_SUBCATEGORIES = {
    hair: 20,
    face: 21,
    neck: 22,
    shoulder: 23,
    front: 24,
    back: 25,
    waist: 26,
    head: 54,
    tshirt: 58,
    shirt: 59,
    pants: 60,
    jacket: 61,
    sweater: 62,
    shorts: 63,
    dress: 65
};

const CLOTHING_SUBCATEGORIES = {
    tshirt: 55,
    shirt: 56,
    pants: 57
};

const ANIMATION_SUBCATEGORIES = {
    avatar: 27,
    bundle: 38,
    emote: 39
};

function response(statusCode, body) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": ACCESS_CONTROL_ALLOW_ORIGIN,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        },
        body: JSON.stringify(body)
    };
}

function errorResponse(statusCode, message, extra = {}) {
    return response(statusCode, {
        success: false,
        error: message,
        ...extra
    });
}

function getPage(event) {
    const value = Number(event.queryStringParameters?.page || 1);

    if (!Number.isInteger(value) || value < 1) {
        return 1;
    }

    return value;
}

function getLimit(event) {
    const value = Number(
        event.queryStringParameters?.limit || DEFAULT_LIMIT
    );

    if (!Number.isInteger(value) || value < 1) {
        return DEFAULT_LIMIT;
    }

    return Math.min(value, MAX_LIMIT);
}

function parseInteger(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed)) {
        return null;
    }

    return parsed;
}

function appendIfPresent(params, name, value) {
    if (value !== undefined && value !== null && value !== "") {
        params.set(name, String(value));
    }
}

function buildRobloxSearchParams(query, options = {}) {
    const params = new URLSearchParams();

    appendIfPresent(params, "Category", options.category);
    appendIfPresent(params, "Subcategory", options.subcategory);

    appendIfPresent(params, "Keyword", query);

    appendIfPresent(params, "CreatorType", options.creatorType);
    appendIfPresent(params, "CreatorTargetId", options.creatorTargetId);
    appendIfPresent(params, "CreatorName", options.creatorName);

    appendIfPresent(params, "Genre", options.genre);

    appendIfPresent(params, "MinPrice", options.minPrice);
    appendIfPresent(params, "MaxPrice", options.maxPrice);

    appendIfPresent(params, "SortType", options.sortType);
    appendIfPresent(params, "SortAggregation", options.sortAggregation);

    params.set(
        "Limit",
        String(
            Math.min(
                options.limit || ROBLOX_PAGE_LIMIT,
                ROBLOX_PAGE_LIMIT
            )
        )
    );

    if (options.cursor) {
        params.set("Cursor", options.cursor);
    }

    return params;
}

async function robloxRequest(path, options = {}) {
    const url = `${ROBLOX_CATALOG_API}${path}`;

    const requestOptions = {
        method: options.method || "GET",
        headers: {
            Accept: "application/json",
            "User-Agent": "SkunkBlox-Catalog-API/1.0"
        }
    };

    if (options.body !== undefined) {
        requestOptions.headers["Content-Type"] = "application/json";
        requestOptions.body = JSON.stringify(options.body);
    }

    const result = await fetch(url, requestOptions);

    const text = await result.text();

    let data;

    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = {
            raw: text
        };
    }

    if (!result.ok) {
        const error = new Error(
            `Roblox Catalog API returned HTTP ${result.status}`
        );

        error.status = result.status;
        error.data = data;

        throw error;
    }

    return data;
}

/*
 * Roblox Marketplace search uses cursors.
 *
 * SkunkBlox exposes:
 *
 *   ?page=1
 *   ?page=2
 *   ?page=3
 *
 * To preserve that interface, page N is constructed by walking the
 * Roblox cursor chain from page 1.
 *
 * This deliberately does not pretend that Roblox has a numeric page
 * parameter.
 */
async function searchRobloxItems({
    page = 1,
    limit = DEFAULT_LIMIT,
    keyword = "",
    options = {}
}) {
    const requestedPage = Math.max(1, page);
    const requestedLimit = Math.min(
        Math.max(1, limit),
        MAX_LIMIT
    );

    let cursor = null;
    let currentPage = 1;
    let finalResult = null;

    while (currentPage <= requestedPage) {
        const params = buildRobloxSearchParams(
            keyword,
            {
                ...options,
                limit: ROBLOX_PAGE_LIMIT,
                cursor
            }
        );

        finalResult = await robloxRequest(
            `/search/items/details?${params.toString()}`
        );

        if (currentPage === requestedPage) {
            break;
        }

        if (!finalResult?.nextPageCursor) {
            return {
                page: requestedPage,
                limit: requestedLimit,
                assets: [],
                nextPage: null,
                previousPage:
                    requestedPage > 1
                        ? requestedPage - 1
                        : null,
                hasNextPage: false,
                hasPreviousPage: requestedPage > 1
            };
        }

        cursor = finalResult.nextPageCursor;
        currentPage++;
    }

    const assets = Array.isArray(finalResult?.data)
        ? finalResult.data.slice(0, requestedLimit)
        : [];

    return {
        page: requestedPage,
        limit: requestedLimit,
        assets,

        // Keep Roblox's cursor available for clients that need
        // direct cursor-based navigation.
        nextPageCursor: finalResult?.nextPageCursor || null,
        previousPageCursor: finalResult?.previousPageCursor || null,

        nextPage: finalResult?.nextPageCursor
            ? requestedPage + 1
            : null,

        previousPage:
            requestedPage > 1
                ? requestedPage - 1
                : null,

        hasNextPage: Boolean(finalResult?.nextPageCursor),
        hasPreviousPage: requestedPage > 1
    };
}

function getCommonFilters(event) {
    const query = event.queryStringParameters || {};

    return {
        creatorType: query.creatorType,
        creatorTargetId: parseInteger(query.creatorTargetId),
        creatorName: query.creatorName,

        genre: parseInteger(
            query.genre || query.genres
        ),

        minPrice: parseInteger(
            query.minPrice
        ),

        maxPrice: parseInteger(
            query.maxPrice
        ),

        sortType: parseInteger(
            query.sortType
        ),

        sortAggregation: parseInteger(
            query.sortAggregation
        )
    };
}

async function getCatalog(event) {
    const page = getPage(event);
    const limit = getLimit(event);

    const filters = getCommonFilters(event);

    return searchRobloxItems({
        page,
        limit,
        options: {
            ...filters,

            // Category 1 = All.
            category: 1
        }
    });
}

async function getAccessories(event) {
    const query = event.queryStringParameters || {};

    const page = getPage(event);
    const limit = getLimit(event);

    const filters = getCommonFilters(event);

    let subcategory = null;

    if (query.type) {
        const normalizedType = String(query.type)
            .trim()
            .toLowerCase();

        subcategory =
            ACCESSORY_SUBCATEGORIES[normalizedType] ||
            parseInteger(normalizedType);
    }

    return searchRobloxItems({
        page,
        limit,
        options: {
            ...filters,

            // Category 11 = Accessories.
            category: 11,
            subcategory
        }
    });
}

async function getClothing(event) {
    const query = event.queryStringParameters || {};

    const page = getPage(event);
    const limit = getLimit(event);

    const filters = getCommonFilters(event);

    let subcategory = null;

    if (query.type) {
        const normalizedType = String(query.type)
            .trim()
            .toLowerCase();

        subcategory =
            CLOTHING_SUBCATEGORIES[normalizedType] ||
            parseInteger(normalizedType);
    }

    return searchRobloxItems({
        page,
        limit,
        options: {
            ...filters,

            // Category 3 = Clothing.
            category: 3,
            subcategory
        }
    });
}

async function getAnimations(event) {
    const query = event.queryStringParameters || {};

    const page = getPage(event);
    const limit = getLimit(event);

    const filters = getCommonFilters(event);

    let subcategory = null;

    if (query.type) {
        const normalizedType = String(query.type)
            .trim()
            .toLowerCase();

        subcategory =
            ANIMATION_SUBCATEGORIES[normalizedType] ||
            parseInteger(normalizedType);
    }

    return searchRobloxItems({
        page,
        limit,
        options: {
            ...filters,

            // Category 12 = Avatar Animations.
            category: 12,
            subcategory
        }
    });
}

async function searchCatalog(event) {
    const query = event.queryStringParameters || {};

    const keyword = String(
        query.t ||
        query.q ||
        ""
    ).trim();

    if (!keyword) {
        return errorResponse(
            400,
            "Missing search query. Use ?t=<query>."
        );
    }

    const page = getPage(event);
    const limit = getLimit(event);

    const filters = getCommonFilters(event);

    return searchRobloxItems({
        page,
        limit,
        keyword,
        options: filters
    });
}

async function getAsset(assetId) {
    if (!/^\d+$/.test(assetId)) {
        return errorResponse(
            400,
            "Invalid asset ID."
        );
    }

    /*
     * Roblox's catalog details endpoint is POST and accepts
     * one or more catalog item IDs.
     */
    const data = await robloxRequest(
        "/catalog/items/details",
        {
            method: "POST",
            body: {
                items: [
                    {
                        id: Number(assetId),
                        itemType: "Asset"
                    }
                ]
            }
        }
    );

    const items = Array.isArray(data?.data)
        ? data.data
        : [];

    if (!items.length) {
        return errorResponse(
            404,
            "Asset not found."
        );
    }

    return response(200, {
        success: true,
        asset: items[0]
    });
}

async function parseBody(event) {
    if (!event.body) {
        return null;
    }

    try {
        return JSON.parse(event.body);
    } catch {
        return null;
    }
}

async function submitReview(event) {
    if (!REVIEW_WEBHOOK_URL) {
        return errorResponse(
            503,
            "Catalog review service is not configured."
        );
    }

    const body = await parseBody(event);

    if (!body || typeof body !== "object") {
        return errorResponse(
            400,
            "Request body must be valid JSON."
        );
    }

    const assetId = body.assetId;
    const description = body.description;
    const reviewer = body.reviewer;

    if (
        assetId === undefined ||
        assetId === null ||
        !/^\d+$/.test(String(assetId))
    ) {
        return errorResponse(
            400,
            "assetId is required and must be a numeric Roblox asset ID."
        );
    }

    if (
        typeof description !== "string" ||
        !description.trim()
    ) {
        return errorResponse(
            400,
            "description is required."
        );
    }

    if (description.length > 4000) {
        return errorResponse(
            400,
            "description is too long. Maximum length is 4000 characters."
        );
    }

    const safeReviewer =
        typeof reviewer === "string" &&
        reviewer.trim()
            ? reviewer.trim().slice(0, 200)
            : "Unknown";

    const webhookPayload = {
        username: "SkunkBlox Catalog",
        embeds: [
            {
                title: "Humanoid Description Review",
                color: 0x4f46e5,
                fields: [
                    {
                        name: "Asset ID",
                        value: String(assetId),
                        inline: true
                    },
                    {
                        name: "Reviewer",
                        value: safeReviewer,
                        inline: true
                    },
                    {
                        name: "Description",
                        value: description.trim().slice(0, 4000),
                        inline: false
                    }
                ],
                timestamp: new Date().toISOString()
            }
        ]
    };

    const webhookResponse = await fetch(
        REVIEW_WEBHOOK_URL,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(webhookPayload)
        }
    );

    if (!webhookResponse.ok) {
        return errorResponse(
            502,
            "Failed to submit catalog review."
        );
    }

    return response(200, {
        success: true,
        message: "Review submitted successfully."
    });
}

async function router(event) {
    const path = event.path || "";

    /*
     * Netlify normally invokes this function at:
     *
     * /catalog-api
     *
     * If redirects/proxying expose it as:
     *
     * /catalog/*
     *
     * we normalize both forms.
     */
    let route = path;

    const functionIndex = route.indexOf(
        "/catalog-api"
    );

    if (functionIndex !== -1) {
        route = route.slice(
            functionIndex + "/catalog-api".length
        );
    }

    const catalogIndex = route.indexOf(
        "/catalog"
    );

    if (catalogIndex !== -1) {
        route = route.slice(
            catalogIndex + "/catalog".length
        );
    }

    if (!route || route === "/") {
        return getCatalog(event);
    }

    if (route === "/submit-review") {
        if (event.httpMethod !== "POST") {
            return errorResponse(
                405,
                "Method Not Allowed."
            );
        }

        return submitReview(event);
    }

    if (route === "/accessories") {
        return getAccessories(event);
    }

    if (route === "/clothing") {
        return getClothing(event);
    }

    if (route === "/animations") {
        return getAnimations(event);
    }

    if (route === "/query") {
        return searchCatalog(event);
    }

    const assetMatch = route.match(
        /^\/(\d+)$/
    );

    if (assetMatch) {
        return getAsset(assetMatch[1]);
    }

    return errorResponse(
        404,
        "Catalog endpoint not found."
    );
}

exports.handler = async (event) => {
    try {
        if (event.httpMethod === "OPTIONS") {
            return response(204, null);
        }

        if (
            event.httpMethod !== "GET" &&
            event.httpMethod !== "POST"
        ) {
            return errorResponse(
                405,
                "Method Not Allowed."
            );
        }

        return await router(event);
    } catch (error) {
        console.error(
            "SkunkBlox Catalog API error:",
            error
        );

        if (error.status) {
            return errorResponse(
                error.status,
                "Roblox Catalog API request failed.",
                {
                    roblox: error.data || null
                }
            );
        }

        return errorResponse(
            500,
            "Internal server error."
        );
    }
};
