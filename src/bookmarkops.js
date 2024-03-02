import * as cheerio from 'cheerio';
import { create, count, insertMultiple, searchVector, getByID, save, load } from '@orama/orama';
import { PipelineSingleton, embed } from './modeling.js';
import { auth_headers } from "./auth.js";

class LocalDBSingleton {
	static dbNamePrefix = 'librarian-vector-db-'
	static dbInstance = null;
	static profileId = '';
	static dbName = '';

	static async getInstance() {
		if (this.dbInstance == null) {
			const profile = await chrome.identity.getProfileUserInfo();
			this.dbName = this.dbNamePrefix + profile.id;

			console.log('Creating DB: ' + this.dbName);
			this.dbInstance = await create({
				id: this.dbName,
				schema: {
					id: 'string',
					embedding: 'vector[384]',
				},
			});
			await this.restoreVector();
		}

		return this.dbInstance;
	}

	static async saveVectorIfNeeded() {
        if (this.dbInstance) { 
			console.log('Saving DB Instance');
            const dbExport = await save(this.dbInstance);
			if (dbExport) {
				let serialized = {};
				serialized[this.dbName] = JSON.stringify(dbExport);
				chrome.storage.local.set(serialized).then(() => {
					console.log('Saved OK');
				});
			}
        }
    }

	static async restoreVector() {
        if (this.dbInstance) {
			console.log('Restoring DB Instance');
            chrome.storage.local.get(this.dbName).then((result) => {
				if (result && Object.keys(result).includes(this.dbName)) {
					load(this.dbInstance, JSON.parse(result[this.dbName]));
				}
			});
        }
    }
}

const getDBCount = async (dbInstance) => {
	return await count(dbInstance);
};

// Subselect text from page to embed
// TODO: make this smarter, parse out HTML
const subselectText = (dom, n_paras=3) => {
	const strippedText = dom('div').text().trim().replace(/\n\s*\n/g, '\n');
	// Filter paragraphs smaller than 50 characters; filter duplicate paras
	let salientParagraphs = new Set(strippedText.split('\n').filter(text => text.length >= 50));
	// Get n_paras biggest paragraphs
	salientParagraphs = Array.from(salientParagraphs).toSorted((a, b) => b.length - a.length);
	const selectedText = salientParagraphs.slice(0, n_paras).join('\n');
	return selectedText;
};

async function is_there_chunk_for_url(url) {
	const response = await fetch("https://api.trieve.ai/api/chunk/tracking_id/" + encodeURIComponent(url.toString()), {
		headers: {
			...(await auth_headers()),
		}
	});
	return response.ok;
}

// TODO: too slow right now, make this go brrr
const scrapeAndVectorize = async (dbInstance, pipelineInstance, bookmark) => {
	return new Promise(resolve => {
		const url = bookmark.url;
		//getByID(dbInstance, url).then((result) => {
		is_there_chunk_for_url(url).then((result) => {
			// URL's already been indexed, do nothing
			if (result) {
				resolve({});
				return;
			}

			const text = fetch(url).then(res => res.text()).then(res => {
				const dom = cheerio.load(res);
				return subselectText(dom);
			}).catch(error => bookmark.title);

			text.then(async (res) => {
				res = res ? res : bookmark.title;
				/*embed(pipelineInstance, res).then(vector => {
					resolve({
						id: url,
						title: bookmark.title,
						url: url,
						embedding: vector
					});
				}).catch(error => resolve({}));*/

				try {
					const response = await fetch("https://api.trieve.ai/api/chunk", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							...(await auth_headers()),
						},
						body: JSON.stringify({
							chunk_html: res,
							link: url.toString(),
							tracking_id: url.toString(),
						}),
					});
					if (!response.ok) {
						console.warn(response);
						const msg = "POST chunk returned " + response.status;
						console.error(msg);
						try { console.error(await response.text()); } catch (ignored) {}
						throw new Error(msg);
					}
				} catch (e) {
					console.error(e);
					console.error("POST chunk died");
					throw e;
				}
			}).finally(error => resolve({}));
		}).catch(error => {
			resolve({});
		});
	});
};

const indexBookmarks = (dbInstance) => {
	if (dbInstance) {
		chrome.bookmarks.getTree(async (tree) => {
			// for testing: .slice(0, 200);
			const bookmarksList = dumpTreeNodes(tree[0].children);
			const pipelineInstance = await PipelineSingleton.getInstance();
			let progress = 0;
			let dataToInsert = {};

			chrome.storage.sync.set({
				'librarian-ops-indexingInProgress': true, 
				'librarian-ops-bookmarksLength': bookmarksList.length,
				'librarian-ops-bookmarksCounter': 0
			});

			console.log('Started indexing: ' + Date.now());
			const embeddedData = await Promise.all(bookmarksList.map(async (bookmark) => {
				// TODO: fix/improve progress, this is directionally right but doesnt indicate completion right
				return scrapeAndVectorize(dbInstance, pipelineInstance, bookmark).then(result => {
					progress++;
					if (progress % 10 == 0 || progress == bookmarksList.length - 1)
						chrome.storage.sync.set({ 'librarian-ops-bookmarksCounter': progress});
					return result;
				});
			}));

			embeddedData.forEach((result) => {
				if (result)
					dataToInsert[result.url] = result;
			});

			await insertMultiple(dbInstance, Object.values(dataToInsert), 750);
			LocalDBSingleton.saveVectorIfNeeded();
			console.log("Finished indexing: " + Date.now());

			chrome.storage.sync.set({ 'librarian-ops-indexingInProgress': false });
		});
	}
}

const dumpTreeNodes = (nodes) => {
	let sublist = [];

	for (const node of nodes) {
		if (node.children)
			sublist.push(...dumpTreeNodes(node.children));

		if (node.url)
			sublist.push({
				'url': node.url,
				'title': node.title
			});
	}

	return sublist;
}

function process_flavor_html(html) {
	const b_first = html.indexOf("<b>");
	const b_last = html.lastIndexOf("</b>");
	if (b_first < 0 || b_last < 0) return "<flavor text error>";
	
}

const searchBookmarks = async (dbInstance, query) => {
	if (!dbInstance) return [];

	const raw_bookmarks = await new Promise(resolve => chrome.bookmarks.getTree(resolve));
	const bookmarksList = dumpTreeNodes(raw_bookmarks[0].children);

	/*const pipelineInstance = await PipelineSingleton.getInstance();
	const queryEmbed = await embed(pipelineInstance, query);
	const result = await searchVector(dbInstance, {
		vector: queryEmbed,
		property: 'embedding',
		similarity: 0.3,
		includeVectors: false,
		limit: 20,
		offset: 0,
	})*/
	const score_threshold = 0.05;
	const response = await fetch("https://api.trieve.ai/api/chunk/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(await auth_headers()),
		},
		body: JSON.stringify({
			page_size: 100,
			page: 0,
			query: query,
			score_threshold: score_threshold,
			search_type: "hybrid",
		}),
	});
	
	if (!response.ok) {
		console.warn(response);
		const msg = "Search query returned non success: " + response.status;
		console.error(msg);
		try { console.error(await response.text()); } catch (ignored) {}
		throw new Error(msg);
	}
	const payload = await response.json();

	try {
		payload.score_chunks.sort((a, b) => b.score - a.score);
		console.log(payload);
		const results = payload.score_chunks
			.filter(chunk => chunk.score >= score_threshold)
			.map(chunk => 
				chunk.metadata.map(metadata => { return {
					document: {
						url: metadata.link,
						title: bookmarksList.find(bookmark => bookmark.url === metadata.link)?.title ?? metadata.link,
						flavor_html: process_flavor_html(metadata.chunk_html),
					}
				} })
			)
			.flat();
		return results;
	} catch (e) {
		console.error(e);
		throw e;
	}
			
	return [];
	//return result.hits;
};

export { getDBCount, indexBookmarks, searchBookmarks, LocalDBSingleton };