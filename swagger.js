// DOM References
const canvas = document.getElementById('canvas');
const svg = document.getElementById('wires');
const nodesContainer = document.getElementById('nodes-container');
const modeSelector = document.getElementById('mode-selector');
const tagSelector = document.getElementById('tag-selector');
const endpointSelector = document.getElementById('endpoint-selector');
const searchInput = document.getElementById('search-input');
const showModelsCb = document.getElementById('show-models-cb');
const showModelsLabel = document.getElementById('show-models-label');
const btnUpload = document.getElementById('btn-upload');
const btnResetLayout = document.getElementById('btn-reset-layout');
const fileInput = document.getElementById('file-input');
const loadedFileName = document.getElementById('loaded-file-name');
const rememberFileCb = document.getElementById('remember-file-cb');
const welcomeMessage = document.getElementById('welcome-message');

const detailsDrawer = document.getElementById('details-drawer');
const drawerTitle = document.getElementById('drawer-title');
const drawerContent = document.getElementById('drawer-content');
const drawerCloseBtn = document.getElementById('drawer-close-btn');

// Global State
let swaggerData = null;
let parsedSwagger = {
    tags: {},        // tag -> [endpointIds]
    tagDetails: {},  // tag -> description
    endpoints: {},   // endpointId -> details object
    schemas: {},     // schemaName -> schema object
    schemaReferences: {} // schemaName -> [endpointIds/schemaNames using it]
};

let activeMode = 'tag'; // 'tag' or 'endpoint'
let activeTag = '';
let activeEndpointId = '';
let showModels = false;
let searchQuery = '';

let nodes = []; // Active nodes on the graph
let links = []; // Active links

let layoutStore = {}; // tag/endpointId -> { nodeId -> {left, top} }
let selectedNodeId = null;

// Pan & Zoom state
let panX = 0;
let panY = 0;
let zoomScale = 1.0;

// Initialize layout from localStorage
function initLayoutStore() {
    const stored = localStorage.getItem('swagger_layout_store_v2');
    if (stored) {
        try {
            layoutStore = JSON.parse(stored);
        } catch (e) {
            layoutStore = {};
        }
    }
}

function saveLayoutStore() {
    localStorage.setItem('swagger_layout_store_v2', JSON.stringify(layoutStore));
}

// Get store layout key for current view
function getLayoutKey() {
    if (activeMode === 'tag') {
        return `tag_${activeTag || 'none'}`;
    } else {
        return `ep_${activeEndpointId || 'none'}`;
    }
}

// Helper to resolve OpenAPI/Swagger local references
function resolveSchema(ref) {
    if (!ref || !ref.startsWith('#/')) return null;
    const parts = ref.split('/').slice(1);
    let current = swaggerData;
    for (const part of parts) {
        if (!current || !current[part]) return null;
        current = current[part];
    }
    return current;
}

// Extract model name from reference string (OpenAPI v2 & v3)
function getSchemaNameFromRef(ref) {
    if (!ref) return '';
    return ref.split('/').pop();
}

// Recursively find model references in schema object
function findRefsInSchema(schemaObj, callback) {
    if (!schemaObj) return;
    if (schemaObj.$ref) {
        callback(getSchemaNameFromRef(schemaObj.$ref));
    }
    if (schemaObj.properties) {
        Object.values(schemaObj.properties).forEach(prop => {
            findRefsInSchema(prop, callback);
        });
    }
    if (schemaObj.items) {
        findRefsInSchema(schemaObj.items, callback);
    }
    if (schemaObj.allOf) {
        schemaObj.allOf.forEach(sub => findRefsInSchema(sub, callback));
    }
    if (schemaObj.anyOf) {
        schemaObj.anyOf.forEach(sub => findRefsInSchema(sub, callback));
    }
    if (schemaObj.oneOf) {
        schemaObj.oneOf.forEach(sub => findRefsInSchema(sub, callback));
    }
}

// Parse input OpenAPI/Swagger object
function parseSwagger(data) {
    swaggerData = data;

    parsedSwagger = {
        tags: {},
        tagDetails: {},
        endpoints: {},
        schemas: {},
        schemaReferences: {}
    };

    // Extract tag descriptions
    if (data.tags && Array.isArray(data.tags)) {
        data.tags.forEach(t => {
            parsedSwagger.tagDetails[t.name] = t.description || '';
        });
    }

    // Extract schemas (v3 components/schemas, v2 definitions)
    const schemas = (data.components && data.components.schemas) || data.definitions || {};
    Object.keys(schemas).forEach(name => {
        parsedSwagger.schemas[name] = schemas[name];
        parsedSwagger.schemaReferences[name] = new Set();
    });

    // Extract paths and methods (endpoints)
    const paths = data.paths || {};
    Object.keys(paths).forEach(path => {
        Object.keys(paths[path]).forEach(method => {
            // Skip parameters defined at the path root level
            if (['parameters', '$ref'].includes(method)) return;

            const epData = paths[path][method];
            const endpointId = `ep_${method}_${path}`;
            const tag = (epData.tags && epData.tags[0]) || 'General';

            if (!parsedSwagger.tags[tag]) {
                parsedSwagger.tags[tag] = [];
            }
            parsedSwagger.tags[tag].push(endpointId);

            // Prepare endpoint details
            const details = {
                id: endpointId,
                path: path,
                method: method,
                tag: tag,
                summary: epData.summary || epData.description || '',
                description: epData.description || '',
                parameters: epData.parameters || [],
                requestBody: null,
                responses: {}
            };

            // Handle request body (OpenAPI v3)
            if (epData.requestBody) {
                const bodyContent = epData.requestBody.content || {};
                const jsonBody = bodyContent['application/json'] || bodyContent['text/json'] || bodyContent['application/*+json'];
                if (jsonBody && jsonBody.schema) {
                    details.requestBody = {
                        schema: jsonBody.schema,
                        description: epData.requestBody.description || ''
                    };

                    // Register schema references
                    findRefsInSchema(jsonBody.schema, (refName) => {
                        if (parsedSwagger.schemaReferences[refName]) {
                            parsedSwagger.schemaReferences[refName].add(endpointId);
                        }
                    });
                }
            }
            // Handle body parameter (OpenAPI v2 fallback)
            else if (epData.parameters) {
                const bodyParam = epData.parameters.find(p => p.in === 'body');
                if (bodyParam && bodyParam.schema) {
                    details.requestBody = {
                        schema: bodyParam.schema,
                        description: bodyParam.description || ''
                    };

                    // Register schema references
                    findRefsInSchema(bodyParam.schema, (refName) => {
                        if (parsedSwagger.schemaReferences[refName]) {
                            parsedSwagger.schemaReferences[refName].add(endpointId);
                        }
                    });
                }
            }

            // Handle responses
            const responses = epData.responses || {};
            Object.keys(responses).forEach(status => {
                const resp = responses[status];
                const respDetails = {
                    description: resp.description || '',
                    schema: null
                };

                const respContent = resp.content || {};
                const jsonResp = respContent['application/json'] || respContent['text/json'] || respContent['text/plain'] || respContent['application/*+json'];

                // OpenAPI v3 schema resolution
                if (jsonResp && jsonResp.schema) {
                    respDetails.schema = jsonResp.schema;

                    findRefsInSchema(jsonResp.schema, (refName) => {
                        if (parsedSwagger.schemaReferences[refName]) {
                            parsedSwagger.schemaReferences[refName].add(endpointId);
                        }
                    });
                }
                // OpenAPI v2 schema resolution
                else if (resp.schema) {
                    respDetails.schema = resp.schema;

                    findRefsInSchema(resp.schema, (refName) => {
                        if (parsedSwagger.schemaReferences[refName]) {
                            parsedSwagger.schemaReferences[refName].add(endpointId);
                        }
                    });
                }
                details.responses[status] = respDetails;
            });

            parsedSwagger.endpoints[endpointId] = details;
        });
    });

    // Handle schema-to-schema references
    Object.keys(parsedSwagger.schemas).forEach(schemaName => {
        const schemaObj = parsedSwagger.schemas[schemaName];
        findRefsInSchema(schemaObj, (refName) => {
            if (refName !== schemaName && parsedSwagger.schemaReferences[refName]) {
                parsedSwagger.schemaReferences[refName].add(`schema_${schemaName}`);
            }
        });
    });
}

// Update control select dropdowns for tags & endpoints
function updateControls() {
    // Populate tag select
    tagSelector.innerHTML = '';
    const sortedTags = Object.keys(parsedSwagger.tags).sort();
    sortedTags.forEach(tag => {
        const opt = document.createElement('option');
        opt.value = tag;
        opt.textContent = `${tag} (${parsedSwagger.tags[tag].length})`;
        tagSelector.appendChild(opt);
    });
    activeTag = sortedTags[0] || '';

    // Populate endpoint select
    endpointSelector.innerHTML = '';
    const sortedEpIds = Object.keys(parsedSwagger.endpoints).sort((a, b) => {
        const epA = parsedSwagger.endpoints[a];
        const epB = parsedSwagger.endpoints[b];
        return `${epA.tag} ${epA.path}`.localeCompare(`${epB.tag} ${epB.path}`);
    });

    sortedEpIds.forEach(id => {
        const ep = parsedSwagger.endpoints[id];
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `[${ep.tag}] ${ep.method.toUpperCase()} ${ep.path}`;
        endpointSelector.appendChild(opt);
    });
    activeEndpointId = sortedEpIds[0] || '';
}

// Get HTML summary of first 3 properties of a schema to render inside the card
function getSchemaSummaryHtml(schemaObj) {
    if (!schemaObj) return 'No definition';
    if (schemaObj.properties) {
        const props = Object.keys(schemaObj.properties);
        const limit = 3;
        let html = '<ul class="card-prop-list">';
        for (let i = 0; i < Math.min(props.length, limit); i++) {
            const propName = props[i];
            const prop = schemaObj.properties[propName];
            let typeStr = 'any';
            if (prop.$ref) {
                typeStr = getSchemaNameFromRef(prop.$ref);
            } else if (prop.type) {
                typeStr = prop.type;
                if (prop.type === 'array' && prop.items) {
                    const itemType = prop.items.$ref ? getSchemaNameFromRef(prop.items.$ref) : (prop.items.type || 'any');
                    typeStr = `[]${itemType}`;
                }
            }
            html += `<li><strong>${propName}</strong>: ${typeStr}</li>`;
        }
        if (props.length > limit) {
            html += `<li class="more-props">+ ${props.length - limit} more</li>`;
        }
        html += '</ul>';
        return html;
    }
    return schemaObj.type || 'object';
}

// Main render entry point
function renderView() {
    resetPanZoom();
    nodes = [];
    links = [];
    nodesContainer.innerHTML = '';

    // Remove existing SVG wire elements
    const oldWires = svg.querySelectorAll('.wire');
    oldWires.forEach(w => w.remove());

    if (!swaggerData) return;

    const layoutKey = getLayoutKey();
    if (!layoutStore[layoutKey]) {
        layoutStore[layoutKey] = {};
    }

    if (activeMode === 'tag') {
        renderTagView(layoutKey);
    } else {
        renderEndpointView(layoutKey);
    }

    // Refresh wires positioning
    setTimeout(drawWires, 50);
}

// Render Domain Tag Grid View
function renderTagView(layoutKey) {
    if (!activeTag) return;

    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    // 1. Tag domain node (placed on the left side)
    const tagDesc = parsedSwagger.tagDetails[activeTag] || `Domain grouping API operations for ${activeTag}.`;
    const tagNode = {
        id: `tag_${activeTag}`,
        tag: 'Domain',
        badgeClass: 'domain',
        title: activeTag,
        desc: tagDesc,
        left: layoutStore[layoutKey][`tag_${activeTag}`]?.left || 80,
        top: layoutStore[layoutKey][`tag_${activeTag}`]?.top || (centerY - 50),
        data: { type: 'tag', name: activeTag }
    };
    nodes.push(tagNode);

    // 2. Endpoint nodes (rendered in columns to the right)
    const epIds = parsedSwagger.tags[activeTag] || [];

    // Filter using search query
    const filteredEpIds = epIds.filter(id => {
        if (!searchQuery) return true;
        const ep = parsedSwagger.endpoints[id];
        return ep.path.toLowerCase().includes(searchQuery) ||
            ep.summary.toLowerCase().includes(searchQuery);
    });

    const maxRowsPerCol = 6;
    const colWidth = 320;
    const rowHeight = 110;
    const epStartX = 420;
    const numRows = Math.min(filteredEpIds.length, maxRowsPerCol);
    const epStartY = Math.max(50, centerY - (numRows * rowHeight) / 2);

    // Collect related unique models if "Show models" is checked
    const schemasToRender = new Set();
    const endpointToSchemaLinks = [];

    filteredEpIds.forEach((id, i) => {
        const ep = parsedSwagger.endpoints[id];
        const colIndex = Math.floor(i / maxRowsPerCol);
        const rowIndex = i % maxRowsPerCol;

        let defaultLeft = epStartX + colIndex * colWidth;
        let defaultTop = epStartY + rowIndex * rowHeight;

        const epNode = {
            id: id,
            tag: ep.method.toUpperCase(),
            badgeClass: ep.method.toLowerCase(),
            title: ep.path,
            desc: ep.summary || 'No description.',
            left: layoutStore[layoutKey][id]?.left || defaultLeft,
            top: layoutStore[layoutKey][id]?.top || defaultTop,
            data: { type: 'endpoint', detail: ep }
        };
        nodes.push(epNode);

        // Connection link from tag to endpoint
        links.push({
            from: `tag_${activeTag}`,
            fromSide: 'right',
            to: id,
            toSide: 'left',
            type: 'tag-flow'
        });

        // Resolve models connection if requested
        if (showModels) {
            // Request models
            if (ep.requestBody && ep.requestBody.schema) {
                findRefsInSchema(ep.requestBody.schema, (refName) => {
                    schemasToRender.add(refName);
                    endpointToSchemaLinks.push({ from: id, to: `schema_${refName}` });
                });
            }
            // Response models (success 2xx)
            Object.keys(ep.responses).forEach(status => {
                if (status.startsWith('2')) {
                    const resp = ep.responses[status];
                    if (resp && resp.schema) {
                        findRefsInSchema(resp.schema, (refName) => {
                            schemasToRender.add(refName);
                            endpointToSchemaLinks.push({ from: id, to: `schema_${refName}` });
                        });
                    }
                }
            });
        }
    });

    // 3. Schema model nodes
    if (showModels && schemasToRender.size > 0) {
        const schemaArray = Array.from(schemasToRender);

        const numEpCols = Math.ceil(filteredEpIds.length / maxRowsPerCol);
        const schemaStartX = epStartX + numEpCols * colWidth + 80;

        const numSchemaRows = Math.min(schemaArray.length, maxRowsPerCol);
        const schemaStartY = Math.max(50, centerY - (numSchemaRows * rowHeight) / 2);

        schemaArray.forEach((name, i) => {
            const schemaObj = parsedSwagger.schemas[name];
            const colIndex = Math.floor(i / maxRowsPerCol);
            const rowIndex = i % maxRowsPerCol;

            let defaultLeft = schemaStartX + colIndex * colWidth;
            let defaultTop = schemaStartY + rowIndex * rowHeight;

            const schemaNode = {
                id: `schema_${name}`,
                tag: 'Schema',
                badgeClass: 'schema',
                title: name,
                desc: getSchemaSummaryHtml(schemaObj),
                left: layoutStore[layoutKey][`schema_${name}`]?.left || defaultLeft,
                top: layoutStore[layoutKey][`schema_${name}`]?.top || defaultTop,
                data: { type: 'schema', name: name, obj: schemaObj }
            };
            nodes.push(schemaNode);
        });

        // Wires connecting endpoints to schema models
        endpointToSchemaLinks.forEach(linkInfo => {
            links.push({
                from: linkInfo.from,
                fromSide: 'right',
                to: linkInfo.to,
                toSide: 'left',
                type: 'wire-model'
            });
        });
    }

    // Append card elements to document
    nodes.forEach(n => createNodeCard(n, layoutKey));
}

// Render Single Endpoint Flow View
function renderEndpointView(layoutKey) {
    if (!activeEndpointId) return;

    const ep = parsedSwagger.endpoints[activeEndpointId];
    if (!ep) return;

    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    const col1 = []; // Inputs (Parameters, Request Schema)
    const col2 = []; // Endpoint node itself (Center)
    const col3 = []; // Response statuses
    const col4 = []; // Response model details

    // 1. Center endpoint card
    const epNode = {
        id: ep.id,
        tag: ep.method.toUpperCase(),
        badgeClass: ep.method.toLowerCase(),
        title: ep.path,
        desc: ep.summary || 'No description.',
        left: layoutStore[layoutKey][ep.id]?.left || (centerX - 125),
        top: layoutStore[layoutKey][ep.id]?.top || (centerY - 50),
        data: { type: 'endpoint', detail: ep }
    };
    col2.push(epNode);

    // Skip parameters mapped inside the request body (OpenAPI v2 compatibility)
    const cleanParams = ep.parameters.filter(p => p.in !== 'body');

    // 2. Input parameters card
    if (cleanParams && cleanParams.length > 0) {
        let paramSummary = cleanParams.map(p => `• <strong>${p.name}</strong> (${p.in})`).slice(0, 4).join('<br>');
        if (cleanParams.length > 4) paramSummary += '<br>...more in panel';

        const paramsNodeId = `params_${ep.id}`;
        const paramsNode = {
            id: paramsNodeId,
            tag: 'Parameters',
            badgeClass: 'params',
            title: 'Query Parameters',
            desc: paramSummary,
            left: layoutStore[layoutKey][paramsNodeId]?.left || (centerX - 460),
            top: layoutStore[layoutKey][paramsNodeId]?.top || (centerY - 120),
            data: { type: 'parameters', endpointId: ep.id, list: cleanParams }
        };
        col1.push(paramsNode);

        links.push({
            from: paramsNodeId,
            fromSide: 'right',
            to: ep.id,
            toSide: 'left',
            type: 'tag-flow'
        });
    }

    // 3. Input request body schema card
    if (ep.requestBody && ep.requestBody.schema) {
        let reqSchemaName = getSchemaNameFromRef(ep.requestBody.schema.$ref);
        let schemaObj = null;
        if (reqSchemaName) {
            schemaObj = parsedSwagger.schemas[reqSchemaName];
        } else {
            reqSchemaName = 'Request Schema';
            schemaObj = ep.requestBody.schema;
        }

        const reqNodeId = `schema_req_${ep.id}`;
        const reqNode = {
            id: reqNodeId,
            tag: 'Request Model',
            badgeClass: 'schema',
            title: reqSchemaName,
            desc: getSchemaSummaryHtml(schemaObj),
            left: layoutStore[layoutKey][reqNodeId]?.left || (centerX - 460),
            top: layoutStore[layoutKey][reqNodeId]?.top || (centerY + 40),
            data: { type: 'schema', name: reqSchemaName, obj: schemaObj }
        };
        col1.push(reqNode);

        links.push({
            from: reqNodeId,
            fromSide: 'right',
            to: ep.id,
            toSide: 'left',
            type: 'wire-model'
        });
    }

    // 4. Response status cards & response models
    const responses = Object.keys(ep.responses).sort();
    responses.forEach((status, i) => {
        const resp = ep.responses[status];
        const isError = !status.startsWith('2');
        const respNodeId = `resp_${status}_${ep.id}`;

        let defaultRespTop = centerY - ((responses.length - 1) * 75) + (i * 150) - 50;

        const respNode = {
            id: respNodeId,
            tag: `Response ${status}`,
            badgeClass: isError ? 'response-err' : 'response-2xx',
            title: status,
            desc: resp.description || 'No status description.',
            left: layoutStore[layoutKey][respNodeId]?.left || (centerX + 210),
            top: layoutStore[layoutKey][respNodeId]?.top || defaultRespTop,
            data: { type: 'response', statusCode: status, detail: resp }
        };
        col3.push(respNode);

        links.push({
            from: ep.id,
            fromSide: 'right',
            to: respNodeId,
            toSide: 'left',
            type: `wire-${ep.method}` // Matches wire color to HTTP method
        });

        // 5. Associated response model card
        if (resp.schema) {
            let respSchemaName = getSchemaNameFromRef(resp.schema.$ref);
            let rSchemaObj = null;
            if (respSchemaName) {
                rSchemaObj = parsedSwagger.schemas[respSchemaName];
            } else {
                respSchemaName = `Model ${status}`;
                rSchemaObj = resp.schema;
            }

            const respSchemaNodeId = `schema_resp_${status}_${ep.id}`;
            const respSchemaNode = {
                id: respSchemaNodeId,
                tag: 'Response Model',
                badgeClass: 'schema',
                title: respSchemaName,
                desc: getSchemaSummaryHtml(rSchemaObj),
                left: layoutStore[layoutKey][respSchemaNodeId]?.left || (centerX + 530),
                top: layoutStore[layoutKey][respSchemaNodeId]?.top || defaultRespTop,
                data: { type: 'schema', name: respSchemaName, obj: rSchemaObj }
            };
            col4.push(respSchemaNode);

            links.push({
                from: respNodeId,
                fromSide: 'right',
                to: respSchemaNodeId,
                toSide: 'left',
                type: 'wire-model'
            });
        }
    });

    // Populate active lists
    nodes.push(...col1, ...col2, ...col3, ...col4);

    // Create cards in DOM
    nodes.forEach(n => createNodeCard(n, layoutKey));
}

// Create DOM Node Card
function createNodeCard(nodeData, layoutKey) {
    const sect = document.createElement('section');
    sect.id = nodeData.id;
    sect.className = 'node';

    if (nodeData.badgeClass) {
        sect.classList.add(`method-border-${nodeData.badgeClass}`);
    }

    sect.style.left = `${nodeData.left}px`;
    sect.style.top = `${nodeData.top}px`;

    sect.innerHTML = `
        <span class="port left ${nodeData.badgeClass === 'schema' ? 'purple-port' : ''}" aria-hidden="true"></span>
        <span class="port right ${nodeData.badgeClass === 'schema' ? 'purple-port' : ''}" aria-hidden="true"></span>
        <span class="badge ${nodeData.badgeClass}">${nodeData.tag}</span>
        <h2>${nodeData.title}</h2>
        <p>${nodeData.desc}</p>
      `;

    nodesContainer.appendChild(sect);

    // Make card draggable
    makeDraggable(sect, layoutKey);

    // Single click -> highlight connection and show details in sidebar
    sect.addEventListener('click', (e) => {
        e.stopPropagation();
        highlightNode(nodeData.id);
        showDetails(nodeData.id, nodeData.data);
    });

    // Double click -> jump to Endpoint Flow view
    if (nodeData.data.type === 'endpoint') {
        sect.addEventListener('dblclick', () => {
            activeMode = 'endpoint';
            modeSelector.value = 'endpoint';
            activeEndpointId = nodeData.data.detail.id;
            endpointSelector.value = activeEndpointId;
            handleModeChange();
        });
    }
}

// Drag & drop logic taking zoomScale into account
function makeDraggable(node, layoutKey) {
    let dragging = false;
    let startLeft = 0;
    let startTop = 0;
    let pointerStartX = 0;
    let pointerStartY = 0;

    node.addEventListener('pointerdown', (e) => {
        if (e.target.tagName === 'A') return;
        e.stopPropagation(); // Prevents background canvas pan trigger

        dragging = true;
        node.setPointerCapture(e.pointerId);

        startLeft = parseFloat(node.style.left) || 0;
        startTop = parseFloat(node.style.top) || 0;
        pointerStartX = e.clientX;
        pointerStartY = e.clientY;

        node.style.zIndex = 100;
        node.classList.add('selected');
    });

    node.addEventListener('pointermove', (e) => {
        if (!dragging) return;

        // Mouse delta movement must be scaled down by current zoomScale
        const dx = (e.clientX - pointerStartX) / zoomScale;
        const dy = (e.clientY - pointerStartY) / zoomScale;

        node.style.left = `${startLeft + dx}px`;
        node.style.top = `${startTop + dy}px`;

        drawWires();
    });

    node.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        node.releasePointerCapture(e.pointerId);

        node.style.zIndex = 5;
        if (selectedNodeId !== node.id) {
            node.classList.remove('selected');
        }

        // Save position coordinates
        if (!layoutStore[layoutKey]) {
            layoutStore[layoutKey] = {};
        }
        layoutStore[layoutKey][node.id] = {
            left: parseFloat(node.style.left),
            top: parseFloat(node.style.top)
        };
        saveLayoutStore();
    });
}

// Calculate port coordinates on screen
function getPortCoordinates(nodeId, side) {
    const node = document.getElementById(nodeId);
    if (!node) return { x: 0, y: 0 };

    const left = parseFloat(node.style.left) || 0;
    const top = parseFloat(node.style.top) || 0;
    const width = node.offsetWidth || 250;
    const height = node.offsetHeight || 80;

    const x = (side === 'right') ? (left + width) : left;
    const y = top + (height / 2);

    return { x, y };
}

// Render curved connection wire path
function drawBlueprintCurve(path, start, end, sideStart, sideEnd) {
    const startSign = sideStart === 'right' ? 1 : -1;
    const endSign = sideEnd === 'right' ? 1 : -1;

    const distance = Math.abs(end.x - start.x);
    const curve = Math.max(70, Math.min(distance * 0.45, 220));

    const adjustedEndX = end.x + (endSign * 16);

    const c1x = start.x + startSign * curve;
    const c2x = adjustedEndX + endSign * curve;

    path.setAttribute(
        'd',
        `M ${start.x} ${start.y} C ${c1x} ${start.y}, ${c2x} ${end.y}, ${adjustedEndX} ${end.y}`
    );
}

// Render and position all SVG wires
function drawWires() {
    const currentWires = svg.querySelectorAll('.wire');
    currentWires.forEach(w => w.remove());

    links.forEach(link => {
        const start = getPortCoordinates(link.from, link.fromSide);
        const end = getPortCoordinates(link.to, link.toSide);

        if (start.x === 0 && end.x === 0) return;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.classList.add('wire');
        path.classList.add(link.type);

        // Map connection arrow marker to link type
        let marker = 'url(#arrow)';
        if (link.type === 'tag-flow') marker = 'url(#arrow-purple)';
        else if (link.type === 'wire-get') marker = 'url(#arrow-get)';
        else if (link.type === 'wire-post') marker = 'url(#arrow-post)';
        else if (link.type === 'wire-put' || link.type === 'wire-patch') marker = 'url(#arrow-put)';
        else if (link.type === 'wire-delete') marker = 'url(#arrow-delete)';
        else if (link.type === 'wire-model') marker = 'url(#arrow-purple)';

        path.setAttribute('marker-end', marker);
        path.dataset.from = link.from;
        path.dataset.to = link.to;

        svg.appendChild(path);
        drawBlueprintCurve(path, start, end, link.fromSide, link.toSide);
    });

    if (selectedNodeId) {
        applyWiresHighlighting();
    }
}

// Highlight connected wire nodes
function applyWiresHighlighting() {
    const wires = svg.querySelectorAll('.wire');
    wires.forEach(w => {
        const from = w.dataset.from;
        const to = w.dataset.to;

        if (from === selectedNodeId || to === selectedNodeId) {
            w.classList.add('highlight');
            w.classList.remove('dimmed');
        } else {
            w.classList.add('dimmed');
            w.classList.remove('highlight');
        }
    });
}

// Select and highlight node
function highlightNode(nodeId) {
    selectedNodeId = nodeId;
    const allNodes = document.querySelectorAll('.node');

    allNodes.forEach(node => {
        if (node.id === nodeId) {
            node.classList.add('selected');
            node.classList.remove('dimmed');
        } else {
            node.classList.remove('selected');
            node.classList.add('dimmed');
        }
    });

    applyWiresHighlighting();
}

// Clear selected node highlights
function clearHighlighting() {
    selectedNodeId = null;

    const allNodes = document.querySelectorAll('.node');
    allNodes.forEach(node => {
        node.classList.remove('selected');
        node.classList.remove('dimmed');
    });

    const wires = svg.querySelectorAll('.wire');
    wires.forEach(w => {
        w.classList.remove('highlight');
        w.classList.remove('dimmed');
    });
}

// Render HTML schema parameters table
function renderSchemaPropertiesTable(schemaName, schemaObj) {
    if (!schemaObj) return '<p class="empty-table">No schema details available</p>';

    if (schemaObj.$ref) {
        const resolvedName = getSchemaNameFromRef(schemaObj.$ref);
        const resolved = resolveSchema(schemaObj.$ref);
        return renderSchemaPropertiesTable(resolvedName, resolved);
    }

    if (schemaObj.type === 'array' && schemaObj.items) {
        if (schemaObj.items.$ref) {
            const refName = getSchemaNameFromRef(schemaObj.items.$ref);
            return `<p>Array of objects: <a href="#" class="schema-link" data-schema="${refName}">${refName}</a></p>`;
        }
        return `<p>Array of items: <code>${schemaObj.items.type || 'unknown'}</code></p>`;
    }

    if (schemaObj.type !== 'object' && !schemaObj.properties) {
        return `<p>Simple type: <code>${schemaObj.type || 'unknown'}</code></p>`;
    }

    const requiredFields = new Set(schemaObj.required || []);
    const properties = schemaObj.properties || {};

    let html = `<table class="schema-table">
        <thead>
          <tr>
            <th>Property</th>
            <th>Type</th>
            <th style="text-align: center;">Required</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>`;

    const keys = Object.keys(properties);
    if (keys.length === 0) {
        html += `<tr><td colspan="4" class="empty-table">No properties defined</td></tr>`;
    } else {
        keys.forEach(propName => {
            const prop = properties[propName];
            const isRequired = requiredFields.has(propName);
            const reqText = isRequired ? '<span class="req-star">*</span>' : '';

            let typeCell = '';
            if (prop.$ref) {
                const refName = getSchemaNameFromRef(prop.$ref);
                typeCell = `<a href="#" class="schema-link" data-schema="${refName}">${refName}</a>`;
            } else if (prop.type === 'array' && prop.items) {
                if (prop.items.$ref) {
                    const refName = getSchemaNameFromRef(prop.items.$ref);
                    typeCell = `array&lt;<a href="#" class="schema-link" data-schema="${refName}">${refName}</a>&gt;`;
                } else {
                    typeCell = `array&lt;${prop.items.type || 'any'}&gt;`;
                }
            } else {
                typeCell = prop.type || 'any';
                if (prop.format) {
                    typeCell += ` (${prop.format})`;
                }
                if (prop.nullable) {
                    typeCell += ' | null';
                }
            }

            const desc = prop.description || '';
            const validationRules = [];
            if (prop.minLength !== undefined) validationRules.push(`minLength: ${prop.minLength}`);
            if (prop.maxLength !== undefined) validationRules.push(`maxLength: ${prop.maxLength}`);
            if (prop.minimum !== undefined) validationRules.push(`min: ${prop.minimum}`);
            if (prop.maximum !== undefined) validationRules.push(`max: ${prop.maximum}`);
            if (prop.enum) validationRules.push(`enum: [${prop.enum.join(', ')}]`);

            const valRulesStr = validationRules.length > 0 ? `<div class="val-rules">${validationRules.join(', ')}</div>` : '';

            html += `<tr>
            <td><code>${propName}</code>${reqText}</td>
            <td>${typeCell}</td>
            <td style="text-align: center;">${isRequired ? 'Yes' : 'No'}</td>
            <td>${desc}${valRulesStr}</td>
          </tr>`;
        });
    }

    html += `</tbody></table>`;
    return html;
}

// Display sidebar details panel (Drawer)
function showDetails(nodeId, data) {
    drawerContent.innerHTML = '';

    if (data.type === 'tag') {
        drawerTitle.textContent = `Domain: ${data.name}`;

        const epIds = parsedSwagger.tags[data.name] || [];
        let endpointsListHtml = epIds.map(id => {
            const ep = parsedSwagger.endpoints[id];
            return `<li>
            <a href="#" class="endpoint-jump-link" data-id="${id}">
              <span class="method-badge ${ep.method}">${ep.method}</span>
              <code>${ep.path}</code>
            </a>
          </li>`;
        }).join('');

        drawerContent.innerHTML = `
          <p>${parsedSwagger.tagDetails[data.name] || 'No description for this domain.'}</p>
          <h3>Endpoints in this domain (${epIds.length})</h3>
          <ul style="padding-left: 0; list-style: none;">
            ${endpointsListHtml}
          </ul>
        `;
    }
    else if (data.type === 'endpoint') {
        const ep = data.detail;
        drawerTitle.textContent = `${ep.method.toUpperCase()} ${ep.path}`;

        // Parameters table
        let paramsHtml = '';
        const cleanParams = ep.parameters.filter(p => p.in !== 'body');
        if (cleanParams && cleanParams.length > 0) {
            paramsHtml = `<table class="schema-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>In</th>
                <th>Type</th>
                <th>Required</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>`;

            cleanParams.forEach(p => {
                const isReq = p.required ? '<span class="req-star">*</span>' : '';
                const pType = p.schema ? (p.schema.type || 'string') : (p.type || 'string');
                paramsHtml += `<tr>
              <td><strong>${p.name}</strong>${isReq}</td>
              <td><code>${p.in}</code></td>
              <td>${pType}</td>
              <td style="text-align: center;">${p.required ? 'Yes' : 'No'}</td>
              <td>${p.description || ''}</td>
            </tr>`;
            });
            paramsHtml += `</tbody></table>`;
        } else {
            paramsHtml = '<p>No path, query or header parameters defined.</p>';
        }

        // Request Body details
        let requestBodyHtml = '';
        if (ep.requestBody) {
            let reqSchemaName = getSchemaNameFromRef(ep.requestBody.schema.$ref);
            let detailsBtn = '';
            if (reqSchemaName) {
                detailsBtn = `<p>Request body schema model: <a href="#" class="schema-link" data-schema="${reqSchemaName}">${reqSchemaName}</a></p>`;
            } else {
                detailsBtn = '<p>Request contains inline object definition.</p>';
            }
            requestBodyHtml = `
            <p>${ep.requestBody.description || 'No description for request body.'}</p>
            ${detailsBtn}
          `;
        } else {
            requestBodyHtml = '<p>Method does not require a request body.</p>';
        }

        // Responses list
        let responsesHtml = '<ul style="padding-left: 20px;">';
        Object.keys(ep.responses).forEach(status => {
            const resp = ep.responses[status];
            let respSchemaHtml = '';
            if (resp.schema) {
                const respSchemaName = getSchemaNameFromRef(resp.schema.$ref);
                if (respSchemaName) {
                    respSchemaHtml = ` (Model: <a href="#" class="schema-link" data-schema="${respSchemaName}">${respSchemaName}</a>)`;
                }
            }
            responsesHtml += `<li><strong>${status}</strong>: ${resp.description || 'No status description.'}${respSchemaHtml}</li>`;
        });
        responsesHtml += '</ul>';

        // View flow diagram button inside drawer
        const flowBtnHtml = `<div style="margin-bottom: 20px;">
          <button class="btn btn-alt" id="drawer-btn-view-flow" data-id="${ep.id}">
            🔍 View Endpoint Flow (Flow)
          </button>
        </div>`;

        drawerContent.innerHTML = `
          ${flowBtnHtml}
          <p><strong>Domain:</strong> ${ep.tag}</p>
          <p><strong>Description:</strong> ${ep.description || ep.summary || 'No description.'}</p>
          
          <h3>Query Parameters</h3>
          ${paramsHtml}

          <h3>Request Body</h3>
          ${requestBodyHtml}

          <h3>Responses</h3>
          ${responsesHtml}
        `;

        // Bind transition button
        document.getElementById('drawer-btn-view-flow').addEventListener('click', (e) => {
            activeMode = 'endpoint';
            modeSelector.value = 'endpoint';
            activeEndpointId = e.target.dataset.id;
            endpointSelector.value = activeEndpointId;
            handleModeChange();
        });
    }
    else if (data.type === 'parameters') {
        drawerTitle.textContent = 'Parameters';

        let paramsHtml = `<table class="schema-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>In</th>
              <th>Type</th>
              <th style="text-align: center;">Required</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>`;

        data.list.forEach(p => {
            const isReq = p.required ? '<span class="req-star">*</span>' : '';
            const pType = p.schema ? (p.schema.type || 'string') : (p.type || 'string');
            paramsHtml += `<tr>
            <td><strong>${p.name}</strong>${isReq}</td>
            <td><code>${p.in}</code></td>
            <td>${pType}</td>
            <td style="text-align: center;">${p.required ? 'Yes' : 'No'}</td>
            <td>${p.description || ''}</td>
          </tr>`;
        });
        paramsHtml += `</tbody></table>`;

        drawerContent.innerHTML = paramsHtml;
    }
    else if (data.type === 'response') {
        const r = data.detail;
        drawerTitle.textContent = `Response Status: ${data.statusCode}`;

        let schemaLink = '';
        if (r.schema) {
            const schemaName = getSchemaNameFromRef(r.schema.$ref);
            if (schemaName) {
                schemaLink = `<h3>Response Schema Model</h3>
            <p><a href="#" class="schema-link" data-schema="${schemaName}">${schemaName}</a></p>`;
            }
        }

        drawerContent.innerHTML = `
          <p><strong>Status Description:</strong></p>
          <p>${r.description || 'No description.'}</p>
          ${schemaLink}
        `;
    }
    else if (data.type === 'schema') {
        drawerTitle.textContent = `Model: ${data.name}`;

        // Find references where this model is used
        let usagesHtml = '';
        const refs = parsedSwagger.schemaReferences[data.name];
        if (refs && refs.size > 0) {
            usagesHtml = '<h3>Used in</h3><ul style="padding-left: 20px;">';
            refs.forEach(refId => {
                if (refId.startsWith('ep_')) {
                    const ep = parsedSwagger.endpoints[refId];
                    usagesHtml += `<li>
                <a href="#" class="endpoint-jump-link" data-id="${refId}">
                  Endpoint: <span class="method-badge ${ep.method}">${ep.method}</span> <code>${ep.path}</code>
                </a>
              </li>`;
                } else if (refId.startsWith('schema_')) {
                    const otherSchemaName = refId.replace('schema_', '');
                    usagesHtml += `<li>
                Model: <a href="#" class="schema-link" data-schema="${otherSchemaName}">${otherSchemaName}</a>
              </li>`;
                }
            });
            usagesHtml += '</ul>';
        }

        drawerContent.innerHTML = `
          <p>${data.obj.description || 'No description available for this data model.'}</p>
          <h3>Model Structure</h3>
          ${renderSchemaPropertiesTable(data.name, data.obj)}
          ${usagesHtml}
        `;
    }

    // Bind link clicks to nested schema navigation inside drawer
    drawerContent.querySelectorAll('.schema-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const targetSchemaName = e.target.dataset.schema;
            const targetObj = parsedSwagger.schemas[targetSchemaName];
            if (targetObj) {
                const graphNodeId = `schema_${targetSchemaName}`;
                if (document.getElementById(graphNodeId)) {
                    highlightNode(graphNodeId);

                    const el = document.getElementById(graphNodeId);
                    if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                    }
                }

                showDetails(graphNodeId, {
                    type: 'schema',
                    name: targetSchemaName,
                    obj: targetObj
                });
            }
        });
    });

    // Bind link clicks to jump to endpoint nodes on graph
    drawerContent.querySelectorAll('.endpoint-jump-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            let target = e.target;
            while (target && !target.dataset.id) {
                target = target.parentElement;
            }
            if (!target) return;
            const epId = target.dataset.id;

            if (activeMode === 'tag') {
                const el = document.getElementById(epId);
                if (el) {
                    highlightNode(epId);
                    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                    showDetails(epId, { type: 'endpoint', detail: parsedSwagger.endpoints[epId] });
                } else {
                    const ep = parsedSwagger.endpoints[epId];
                    if (ep) {
                        activeTag = ep.tag;
                        tagSelector.value = activeTag;
                        renderView();
                        setTimeout(() => {
                            highlightNode(epId);
                            const newEl = document.getElementById(epId);
                            if (newEl) newEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                            showDetails(epId, { type: 'endpoint', detail: ep });
                        }, 100);
                    }
                }
            } else {
                activeEndpointId = epId;
                endpointSelector.value = activeEndpointId;
                renderView();
                setTimeout(() => {
                    highlightNode(epId);
                    showDetails(epId, { type: 'endpoint', detail: parsedSwagger.endpoints[epId] });
                }, 100);
            }
        });
    });

    detailsDrawer.classList.add('open');
}

// Close details drawer
function closeDrawer() {
    detailsDrawer.classList.remove('open');
    clearHighlighting();
}

// Handle switching between Tag and Endpoint views
function handleModeChange() {
    activeMode = modeSelector.value;
    if (activeMode === 'tag') {
        tagSelector.style.display = 'inline-block';
        endpointSelector.style.display = 'none';
        showModelsCb.style.display = 'inline-block';
        showModelsLabel.style.display = 'inline-flex';
    } else {
        tagSelector.style.display = 'none';
        endpointSelector.style.display = 'inline-block';
        showModelsCb.style.display = 'none';
        showModelsLabel.style.display = 'none';
    }
    closeDrawer();
    renderView();
}

// Reset saved coordinates from layout store
function resetLayout() {
    const key = getLayoutKey();
    if (layoutStore[key]) {
        delete layoutStore[key];
        saveLayoutStore();
    }
    closeDrawer();
    renderView();
}

// Load default Swagger specification or restore session
function loadDefaultSwagger() {
    const remember = localStorage.getItem('swagger_remember_file') === 'true';
    rememberFileCb.checked = remember;

    if (remember) {
        const cachedData = localStorage.getItem('swagger_cached_data');
        const cachedName = localStorage.getItem('swagger_cached_filename') || 'Previous session';

        if (cachedData) {
            try {
                const data = JSON.parse(cachedData);
                loadedFileName.textContent = cachedName;
                loadedFileName.style.color = 'var(--ok)';
                parseSwagger(data);
                updateControls();
                
                // Hide welcome overlay screen
                welcomeMessage.style.display = 'none';
                
                renderView();
                return;
            } catch (e) {
                console.error('Error loading session from localStorage:', e);
                localStorage.removeItem('swagger_cached_data');
            }
        }
    }

    // Default start is empty
    loadedFileName.textContent = 'No file';
    loadedFileName.style.color = 'var(--warn)';
    welcomeMessage.style.display = 'block';
    nodesContainer.innerHTML = '';
    const oldWires = svg.querySelectorAll('.wire');
    oldWires.forEach(w => w.remove());
}

// Load user uploaded JSON specification file
function handleFileUpload(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const data = JSON.parse(e.target.result);
                loadedFileName.textContent = file.name;
                loadedFileName.style.color = 'var(--ok)';

                // Auto-save to localStorage if checkbox is active
                if (rememberFileCb.checked) {
                    localStorage.setItem('swagger_cached_data', e.target.result);
                    localStorage.setItem('swagger_cached_filename', file.name);
                }

                parseSwagger(data);
                updateControls();
                
                // Hide welcome overlay screen
                welcomeMessage.style.display = 'none';

                closeDrawer();
                renderView();
            } catch (err) {
                alert('An error occurred while parsing the JSON file: ' + err.message);
            }
        };
        reader.readAsText(file);
    }
}

// Bind Control Event Listeners
modeSelector.addEventListener('change', handleModeChange);

tagSelector.addEventListener('change', (e) => {
    activeTag = e.target.value;
    closeDrawer();
    renderView();
});

endpointSelector.addEventListener('change', (e) => {
    activeEndpointId = e.target.value;
    closeDrawer();
    renderView();
});

searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();

    if (activeMode === 'tag') {
        renderView();
    } else {
        const query = searchQuery;
        const options = endpointSelector.options;
        let count = 0;
        for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            const match = opt.textContent.toLowerCase().includes(query);
            opt.style.display = match ? 'block' : 'none';
            if (match && count === 0) {
                if (query.length > 2 && activeEndpointId !== opt.value) {
                    activeEndpointId = opt.value;
                    endpointSelector.value = activeEndpointId;
                    renderView();
                }
                count++;
            }
        }
    }
});

showModelsCb.addEventListener('change', (e) => {
    showModels = e.target.checked;
    closeDrawer();
    renderView();
});

btnUpload.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', handleFileUpload);

btnResetLayout.addEventListener('click', resetLayout);

drawerCloseBtn.addEventListener('click', closeDrawer);

// "Remember file" checkbox toggled
rememberFileCb.addEventListener('change', (e) => {
    const checked = e.target.checked;
    localStorage.setItem('swagger_remember_file', checked ? 'true' : 'false');
    
    if (checked) {
        if (swaggerData) {
            try {
                localStorage.setItem('swagger_cached_data', JSON.stringify(swaggerData));
                localStorage.setItem('swagger_cached_filename', loadedFileName.textContent);
            } catch (err) {
                console.error('Error saving specification to localStorage:', err);
            }
        }
    } else {
        localStorage.removeItem('swagger_cached_data');
        localStorage.removeItem('swagger_cached_filename');
    }
});

// Close drawer when clicking empty canvas areas
canvas.addEventListener('click', (e) => {
    if (e.target === canvas || e.target === svg) {
        closeDrawer();
    }
});

// Update Pan & Zoom Transform scale
function updateTransform() {
    const pzc = document.getElementById('pan-zoom-container');
    if (pzc) {
        pzc.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
    }
}

function resetPanZoom() {
    panX = 0;
    panY = 0;
    zoomScale = 1.0;
    updateTransform();
}

// Background Panning
let isPanning = false;
let panStartX = 0;
let panStartY = 0;

canvas.addEventListener('pointerdown', (e) => {
    if (e.target === canvas || e.target === svg) {
        isPanning = true;
        canvas.setPointerCapture(e.pointerId);
        panStartX = e.clientX - panX;
        panStartY = e.clientY - panY;
        canvas.style.cursor = 'grabbing';
    }
});

canvas.addEventListener('pointermove', (e) => {
    if (isPanning) {
        panX = e.clientX - panStartX;
        panY = e.clientY - panStartY;
        updateTransform();
    }
});

canvas.addEventListener('pointerup', (e) => {
    if (isPanning) {
        isPanning = false;
        canvas.releasePointerCapture(e.pointerId);
        canvas.style.cursor = 'grab';
    }
});

// Zoom relative to mouse cursor position
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();

    const zoomFactor = 1.1;
    let newScale = zoomScale;

    if (e.deltaY < 0) {
        newScale = Math.min(zoomScale * zoomFactor, 2.5);
    } else {
        newScale = Math.max(zoomScale / zoomFactor, 0.2);
    }

    if (newScale === zoomScale) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    panX = mouseX - (mouseX - panX) * (newScale / zoomScale);
    panY = mouseY - (mouseY - panY) * (newScale / zoomScale);
    zoomScale = newScale;

    updateTransform();
}, { passive: false });

// Start initialization
initLayoutStore();
loadDefaultSwagger();

// Redraw lines on window resizing
window.addEventListener('resize', drawWires);
