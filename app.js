// PWA Core Logic & State Management
const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.hostname.startsWith("192.168.")
  ? window.location.origin + "/Curtiss-ERP/Picking"
  : "https://curtiss.suzxlabs.com/picking";

// Secure fetch wrapper to validate and handle session expiry
function fetchSecure(url, options = {}) {
  options.credentials = options.credentials || "include";
  
  return fetch(url, options)
    .then(res => {
      if (res.status === 401 || res.status === 403) {
        handleSessionExpired();
        throw new Error("Unauthorized");
      }
      
      // Check if JSON contains unauthorized flag
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        return res.clone().json().then(data => {
          if (data && data.unauthorized) {
            handleSessionExpired();
            throw new Error("Unauthorized");
          }
          return res;
        }).catch(() => res);
      }
      
      return res;
    });
}

function handleSessionExpired() {
  alert("Your session has expired. Please log in again.");
  state.currentUser = null;
  localStorage.removeItem("curtiss_picking_user");
  localStorage.removeItem("curtiss_picking_sheets");
  showView("view-login");
}

let state = {
  currentUser: JSON.parse(localStorage.getItem("curtiss_picking_user")) || null,
  sheets: JSON.parse(localStorage.getItem("curtiss_picking_sheets")) || [],
  activeSheet: null,
  activeSheetItems: [],
  pendingUpdates: JSON.parse(localStorage.getItem("curtiss_picking_pending_sync")) || {},
  isOnline: navigator.onLine,
  currentTab: "to-pick",
  recentPickedIds: [] // tracked for sorting picked tab by recency
};

// --- 1. SERVICE WORKER REGISTRATION (Disabled to prevent browser SSL validation errors in staging/dev environments) ---
/*
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .then((reg) => console.log("[PWA] Service Worker registered with scope:", reg.scope))
      .catch((err) => {
        console.warn("[PWA] Service Worker registration skipped (expected on untrusted/self-signed SSL development environments):", err.message);
      });
  });
}
*/

// --- 2. INITIALIZATION ---
document.addEventListener("DOMContentLoaded", () => {
  initApp();
  setupEventListeners();
  updateConnectionStatus();
});

function initApp() {
  if (state.currentUser) {
    showView("view-sheets");
    document.getElementById("user-display").innerText = state.currentUser.username;
    loadSheets();
  } else {
    showView("view-login");
  }
  updateSyncBadge();
}

// --- 3. CONNECTION & SYNC ENGINE ---
window.addEventListener("online", () => {
  state.isOnline = true;
  updateConnectionStatus();
  syncOfflineData();
});

window.addEventListener("offline", () => {
  state.isOnline = false;
  updateConnectionStatus();
});

function updateConnectionStatus() {
  const statusBadges = document.querySelectorAll(".status-indicator");
  statusBadges.forEach((badge) => {
    if (state.isOnline) {
      badge.classList.remove("offline");
      badge.classList.add("online");
      badge.innerText = "Online";
    } else {
      badge.classList.remove("online");
      badge.classList.add("offline");
      badge.innerText = "Offline";
    }
  });
}

// Update the red badge count for items modified offline
function updateSyncBadge() {
  const badge = document.getElementById("sync-badge");
  const count = Object.keys(state.pendingUpdates).length;
  if (count > 0) {
    badge.innerText = count;
    badge.style.display = "flex";
  } else {
    badge.style.display = "none";
  }
}

// Queue update for offline synchronization
function queueItemUpdate(item) {
  state.pendingUpdates[item.id] = {
    id: item.id,
    loaded_qty: item.loaded_qty,
    is_picked: item.is_picked,
    updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
  };
  localStorage.setItem("curtiss_picking_pending_sync", JSON.stringify(state.pendingUpdates));
  updateSyncBadge();

  if (state.isOnline) {
    syncOfflineData();
  }
}

// Push local modifications back to ERP database
function syncOfflineData() {
  const keys = Object.keys(state.pendingUpdates);
  if (keys.length === 0 || !state.isOnline) return;

  const updatesArray = keys.map(k => state.pendingUpdates[k]);

  // Extract unique delivery IDs from queued updates to trigger status recalculations
  const deliveryIds = [...new Set(state.activeSheetItems.map(item => item.delivery_id))];

  fetchSecure(`${API_BASE}/api_sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates: updatesArray, delivery_ids: deliveryIds })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      console.log("[PWA] Successfully synchronized offline updates:", data.synced_count);
      state.pendingUpdates = {};
      localStorage.removeItem("curtiss_picking_pending_sync");
      updateSyncBadge();
      // Refresh list of sheets quietly in the background
      loadSheets(true);
    }
  })
  .catch(err => console.error("[PWA] Sync failed:", err));
}

// --- 4. VIEW CONTROLLER ---
function showView(viewId) {
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.remove("active");
  });
  const activeView = document.getElementById(viewId);
  if (activeView) {
    activeView.classList.add("active");
  }
}

// --- 5. AUTHENTICATION FLOW ---
function handleLogin(e) {
  e.preventDefault();
  const usernameVal = document.getElementById("username").value.trim();
  const passwordVal = document.getElementById("password").value.trim();
  const errorEl = document.getElementById("login-error");

  errorEl.style.display = "none";

  if (!state.isOnline) {
    errorEl.innerText = "Connection required to authenticate for the first time.";
    errorEl.style.display = "block";
    return;
  }

  fetch(`${API_BASE}/api_login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: usernameVal, password: passwordVal })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      state.currentUser = data.user;
      localStorage.setItem("curtiss_picking_user", JSON.stringify(data.user));
      document.getElementById("user-display").innerText = data.user.username;
      
      // Clear older cached data
      localStorage.removeItem("curtiss_picking_sheets");
      
      showView("view-sheets");
      loadSheets();
    } else {
      errorEl.innerText = data.error || "Authentication failed.";
      errorEl.style.display = "block";
    }
  })
  .catch(err => {
    errorEl.innerText = "Error reaching authentication server. Try again.";
    errorEl.style.display = "block";
    console.error(err);
  });
}

function handleLogout() {
  state.currentUser = null;
  localStorage.removeItem("curtiss_picking_user");
  showView("view-login");
}

// --- 6. LOADING SHEETS CONTROLLER ---
function loadSheets(quiet = false) {
  const spinner = document.getElementById("sheets-loading-spinner");
  const emptyState = document.getElementById("sheets-empty-state");
  const listContainer = document.getElementById("sheets-list");

  console.log("[PWA] loadSheets called. Online status:", state.isOnline);

  if (!quiet) {
    spinner.style.display = "flex";
    listContainer.innerHTML = "";
  }
  emptyState.style.display = "none";

  const renderLocalData = () => {
    console.log("[PWA] Rendering local sheets data. Count:", state.sheets.length);
    spinner.style.display = "none";
    if (state.sheets.length === 0) {
      emptyState.style.display = "flex";
      return;
    }
    renderSheetsUI(state.sheets);
  };

  if (!state.isOnline) {
    renderLocalData();
    return;
  }

  const fetchUrl = `${API_BASE}/api_get_sheets`;
  console.log("[PWA] Fetching sheets from:", fetchUrl);

  fetchSecure(fetchUrl)
    .then(res => {
      console.log("[PWA] api_get_sheets fetch response status:", res.status);
      return res.json();
    })
    .then(data => {
      console.log("[PWA] api_get_sheets JSON data parsed:", data);
      if (data.success) {
        state.sheets = data.sheets || [];
        localStorage.setItem("curtiss_picking_sheets", JSON.stringify(state.sheets));
        renderSheetsUI(state.sheets);
      } else {
        console.warn("[PWA] api_get_sheets returned success=false", data);
        renderLocalData();
      }
    })
    .catch(err => {
      console.error("[PWA] Error fetching sheets:", err);
      renderLocalData();
    })
    .finally(() => {
      if (!quiet) spinner.style.display = "none";
    });
}

function renderSheetsUI(sheets) {
  console.log("[PWA] renderSheetsUI called with sheets:", sheets);
  const listContainer = document.getElementById("sheets-list");
  listContainer.innerHTML = "";

  const searchInput = document.getElementById("search-sheets");
  const filterSelect = document.getElementById("filter-status");

  const searchVal = searchInput ? searchInput.value.toLowerCase() : "";
  const statusFilter = filterSelect ? filterSelect.value : "all";

  console.log("[PWA] Filter parameters - searchVal:", searchVal, "statusFilter:", statusFilter);

  const filtered = sheets.filter(sheet => {
    if (!sheet) return false;

    const idStr = sheet.id ? sheet.id.toString() : "";
    const routeName = sheet.route_name ? sheet.route_name.toLowerCase() : "";
    const vehicleNumber = sheet.vehicle_number ? sheet.vehicle_number.toLowerCase() : "";
    const driverName = sheet.driver_name ? sheet.driver_name.toLowerCase() : "";
    const customerInfo = sheet.customer_info ? sheet.customer_info.toLowerCase() : "";
    const statusVal = sheet.status ? sheet.status : "";

    const matchesSearch = 
      idStr.includes(searchVal) ||
      routeName.includes(searchVal) ||
      vehicleNumber.includes(searchVal) ||
      driverName.includes(searchVal) ||
      customerInfo.includes(searchVal);

    // Support matching both sheet.status and case-insensitive check
    const matchesStatus = statusFilter === "all" || 
      statusVal.toLowerCase() === statusFilter.toLowerCase();

    return matchesSearch && matchesStatus;
  });

  console.log("[PWA] Filtered sheets count:", filtered.length, "out of", sheets.length);

  if (filtered.length === 0) {
    document.getElementById("sheets-empty-state").style.display = "flex";
    return;
  }

  document.getElementById("sheets-empty-state").style.display = "none";

  filtered.forEach(sheet => {
    const totalItems = parseInt(sheet.total_items) || 0;
    const pickedItems = parseInt(sheet.picked_items) || 0;
    const progressPercent = totalItems > 0 ? Math.round((pickedItems / totalItems) * 100) : 0;

    const card = document.createElement("div");
    card.className = "manifest-card";
    
    const displayStatus = sheet.status || "Pending";
    const statusClass = displayStatus.toLowerCase().replace(/\s+/g, '-');

    card.innerHTML = `
      <div class="manifest-card-header">
        <h3>Loading Sheet #${sheet.id}</h3>
        <span class="manifest-status ${statusClass}">${displayStatus}</span>
      </div>
      <div class="manifest-info-row">
        <span>📍 <strong>Route:</strong> ${sheet.route_name || 'N/A'}</span>
        <span>👥 <strong>Customers:</strong> ${sheet.customer_info || 'N/A'}</span>
        <span>🚚 <strong>Vehicle:</strong> ${sheet.vehicle_number || 'N/A'} (${sheet.driver_name || 'N/A'})</span>
        <span>📅 <strong>Delivery Date:</strong> ${sheet.delivery_date || 'N/A'}</span>
      </div>
      <div class="manifest-progress-wrapper">
        <div class="progress-text">
          <span>Picking Progress</span>
          <span>${pickedItems}/${totalItems} items (${progressPercent}%)</span>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
        </div>
      </div>
    `;

    card.addEventListener("click", () => {
      openActionModal(sheet);
    });

    listContainer.appendChild(card);
  });
}

// --- 7. PICKING SCREEN / ACTION SHEET ---
function openPickingSheet(sheet) {
  state.activeSheet = sheet;
  document.getElementById("picking-sheet-num").innerText = `Loading Sheet #${sheet.id}`;
  document.getElementById("picking-sheet-route").innerText = `Route: ${sheet.route_name}`;
  
  // Set tab slider back to to-pick default
  switchTab("to-pick");

  const localCacheKey = `curtiss_picking_sheet_details_${sheet.id}`;
  const localCachedDetails = JSON.parse(localStorage.getItem(localCacheKey));

  const applyLocalDetails = (items) => {
    // Merge any unsynced offline updates from the queue
    state.activeSheetItems = items.map(item => {
      if (state.pendingUpdates[item.id]) {
        return {
          ...item,
          loaded_qty: parseFloat(state.pendingUpdates[item.id].loaded_qty),
          is_picked: parseInt(state.pendingUpdates[item.id].is_picked)
        };
      }
      return item;
    });
    
    renderPickingUI();
    showView("view-picking");
  };

  if (!state.isOnline) {
    if (localCachedDetails) {
      applyLocalDetails(localCachedDetails);
    } else {
      alert("This sheet is not downloaded for offline usage. Connect to load.");
    }
    return;
  }

  fetchSecure(`${API_BASE}/api_get_sheet_details/${sheet.id}`)
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        localStorage.setItem(localCacheKey, JSON.stringify(data.items));
        applyLocalDetails(data.items);
      } else {
        if (localCachedDetails) applyLocalDetails(localCachedDetails);
      }
    })
    .catch(err => {
      console.error("[PWA] Error fetching sheet details:", err);
      if (localCachedDetails) applyLocalDetails(localCachedDetails);
    });
}

function openActionModal(sheet) {
  state.activeSheet = sheet;
  document.getElementById("action-modal").style.display = "flex";
}

// Queue final loading verification update for offline synchronization
function queueFinalItemUpdate(item) {
  state.pendingUpdates[`final_${item.id}`] = {
    id: item.id,
    final_loaded_qty: item.final_loaded_qty,
    is_verified: item.is_verified,
    user_id: state.currentUser ? state.currentUser.id : null,
    updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
  };
  localStorage.setItem("curtiss_picking_pending_sync", JSON.stringify(state.pendingUpdates));
  updateSyncBadge();

  if (state.isOnline) {
    syncOfflineData();
  }
}

function openFinalLoadingSheet(sheet) {
  state.activeSheet = sheet;
  document.getElementById("final-sheet-num").innerText = `Loading Sheet #${sheet.id}`;
  document.getElementById("final-sheet-route").innerText = `Route: ${sheet.route_name}`;

  const localCacheKey = `curtiss_picking_sheet_details_${sheet.id}`;
  const localCachedDetails = JSON.parse(localStorage.getItem(localCacheKey));

  const applyLocalFinalDetails = (items) => {
    state.activeSheetItems = items.map(item => {
      // Fallback: default final_loaded_qty to loaded_qty (the picked quantity) if it is null
      if (item.final_loaded_qty === null) {
        item.final_loaded_qty = item.required_qty;
      }

      const finalKey = `final_${item.id}`;
      if (state.pendingUpdates[finalKey]) {
        return {
          ...item,
          final_loaded_qty: parseFloat(state.pendingUpdates[finalKey].final_loaded_qty),
          is_verified: parseInt(state.pendingUpdates[finalKey].is_verified),
          variance: parseFloat(state.pendingUpdates[finalKey].final_loaded_qty) - parseFloat(item.required_qty)
        };
      }
      return item;
    });
    
    renderFinalLoadingUI();
    showView("view-final-loading");
  };

  if (!state.isOnline) {
    if (localCachedDetails) {
      applyLocalFinalDetails(localCachedDetails);
    } else {
      alert("This sheet is not downloaded for offline usage. Connect to load.");
    }
    return;
  }

  fetchSecure(`${API_BASE}/api_get_sheet_details/${sheet.id}`)
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        localStorage.setItem(localCacheKey, JSON.stringify(data.items));
        applyLocalFinalDetails(data.items);
      } else {
        if (localCachedDetails) applyLocalFinalDetails(localCachedDetails);
      }
    })
    .catch(err => {
      console.error("[PWA] Error fetching sheet details:", err);
      if (localCachedDetails) applyLocalFinalDetails(localCachedDetails);
    });
}

function renderFinalLoadingUI() {
  const searchVal = document.getElementById("search-products-final").value.toLowerCase();
  
  // Filter products by search term
  const items = state.activeSheetItems.filter(item => 
    item.item_name.toLowerCase().includes(searchVal)
  );

  // Update verified count badge
  const verifiedCount = items.filter(item => item.is_verified === 1).length;
  document.getElementById("final-progress-badge").innerText = `${verifiedCount}/${items.length} Verified`;

  const container = document.getElementById("final-loading-list");
  container.innerHTML = "";

  if (items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📄</div>
        <h3>No Products Found</h3>
      </div>
    `;
    return;
  }

  // Sort products alphabetically
  items.sort((a, b) => a.item_name.localeCompare(b.item_name));

  items.forEach(item => {
    const card = document.createElement("div");
    
    // Compute variance
    const variance = item.final_loaded_qty - item.required_qty;
    let varClass = "exact";
    let varLabel = "Match";
    if (variance < 0) {
      varClass = "short";
      varLabel = `${variance} Short`;
    } else if (variance > 0) {
      varClass = "over";
      varLabel = `+${variance} Over`;
    }

    // Highlight border based on variance/verification status
    let borderClass = "";
    if (item.is_verified) {
      borderClass = "picked";
    } else if (variance !== 0) {
      borderClass = variance > 0 ? "over-picked" : "under-picked";
    }

    card.className = `product-card ${borderClass}`;
    card.id = `final-card-${item.id}`;

    const imageSrc = item.image_path 
      ? `https://curtiss.suzxlabs.com/${item.image_path.replace(/^\/+/, '')}`
      : null;

    let replacementInfoHtml = "";
    if (item.replaced_by_name) {
      replacementInfoHtml = `
        <div style="font-size: 11px; color: #a855f7; font-weight: bold; margin-top: 4px; display: flex; align-items: center; gap: 4px;">
          <span>🔄 Replaced By:</span> <span>${item.replaced_by_name} (Qty: ${item.replacement_qty})</span>
        </div>
      `;
    } else if (item.replaces_name) {
      replacementInfoHtml = `
        <div style="font-size: 11px; color: #10b981; font-weight: bold; margin-top: 4px; display: flex; align-items: center; gap: 4px;">
          <span>★ Substituted for:</span> <span>${item.replaces_name}</span>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="product-img-box">
        ${imageSrc 
          ? `<img src="${imageSrc}" alt="${item.item_name}" onerror="this.outerHTML='<span class=\\'img-fallback\\'>📦</span>'">` 
          : `<span class="img-fallback">📦</span>`}
      </div>
      <div class="product-info">
        <div class="product-name">${item.item_name}</div>
        <div class="qty-req" style="font-size: 11px; color: var(--text-secondary);">
          Required Qty: <strong>${item.required_qty}</strong>
        </div>
        <div style="margin-top: 4px; display: flex; flex-direction: column; gap: 4px;">
          <div><span class="variance-tag ${varClass}">${varLabel}</span></div>
          ${replacementInfoHtml}
        </div>
      </div>
      <div class="qty-adjuster">
        <button class="qty-btn btn-minus" type="button">−</button>
        <div class="qty-input-wrapper">
          <input class="qty-input" type="number" min="0" value="${item.final_loaded_qty}">
        </div>
        <button class="qty-btn btn-plus" type="button">+</button>
      </div>
      <div style="padding-left: 8px; display: flex; flex-direction: column; gap: 6px;">
        <button class="btn-verify ${item.is_verified ? 'verified' : ''}">${item.is_verified ? 'Verified ✓' : 'Verify'}</button>
        ${(!item.replaced_by_name && !item.replaces_name && item.required_qty > 0) 
          ? `<button class="btn-replace" style="padding: 6px 10px; background: #673ab7; color: white; border: none; border-radius: 4px; font-size: 11px; cursor: pointer; font-weight: bold; width: 100%;">Replace</button>` 
          : ''
        }
      </div>
    `;

    // Attach listeners
    const imgBox = card.querySelector(".product-img-box");
    imgBox.addEventListener("click", (e) => {
      e.stopPropagation();
      openImageModal(item.item_name, imageSrc);
    });

    const qtyInput = card.querySelector(".qty-input");
    const btnMinus = card.querySelector(".btn-minus");
    const btnPlus = card.querySelector(".btn-plus");
    const btnVerify = card.querySelector(".btn-verify");
    const btnReplace = card.querySelector(".btn-replace");

    const updateFinalQty = (newVal) => {
      newVal = Math.max(0, parseFloat(newVal) || 0);
      qtyInput.value = newVal;
      item.final_loaded_qty = newVal;
      item.variance = newVal - item.required_qty;
      
      // Reset verified status on change
      item.is_verified = 0;
      
      queueFinalItemUpdate(item);
      renderFinalLoadingUI();
    };

    btnMinus.addEventListener("click", (e) => {
      e.stopPropagation();
      updateFinalQty(item.final_loaded_qty - 1);
    });

    btnPlus.addEventListener("click", (e) => {
      e.stopPropagation();
      updateFinalQty(item.final_loaded_qty + 1);
    });

    qtyInput.addEventListener("change", () => {
      updateFinalQty(qtyInput.value);
    });

    qtyInput.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    btnVerify.addEventListener("click", (e) => {
      e.stopPropagation();
      
      if (item.is_verified === 0) {
        item.is_verified = 1;
      } else {
        item.is_verified = 0;
      }

      queueFinalItemUpdate(item);
      renderFinalLoadingUI();
    });

    if (btnReplace) {
      btnReplace.addEventListener("click", (e) => {
        e.stopPropagation();
        openReplaceProductModal(item);
      });
    }

    container.appendChild(card);
  });
}

// Switch between To Pick / Picked sliding tabs
function switchTab(tabName) {
  state.currentTab = tabName;
  
  document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.remove("active"));
  document.querySelectorAll(".tab-pane").forEach(pane => pane.classList.remove("active"));
  
  const slider = document.querySelector(".tab-slider");
  
  if (tabName === "to-pick") {
    document.getElementById("tab-to-pick").classList.add("active");
    document.getElementById("pane-to-pick").classList.add("active");
    slider.style.transform = "translateX(0%)";
  } else {
    document.getElementById("tab-picked").classList.add("active");
    document.getElementById("pane-picked").classList.add("active");
    slider.style.transform = "translateX(100%)";
  }
}

// Render product picking layout
function renderPickingUI() {
  const searchVal = document.getElementById("search-products").value.toLowerCase();
  
  // Filter products by search term
  const items = state.activeSheetItems.filter(item => 
    item.item_name.toLowerCase().includes(searchVal)
  );

  // Group items by Picked vs To Pick
  const toPickItems = items.filter(item => item.is_picked === 0);
  const pickedItems = items.filter(item => item.is_picked === 1);

  // Update counts
  document.getElementById("count-to-pick").innerText = toPickItems.length;
  document.getElementById("count-picked").innerText = pickedItems.length;

  // --- Render To Pick (Grouped by Category) ---
  const toPickContainer = document.getElementById("to-pick-list");
  toPickContainer.innerHTML = "";

  if (toPickItems.length === 0) {
    toPickContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎉</div>
        <h3>All Items Picked!</h3>
        <p>There are no pending items left to pick on this manifest.</p>
      </div>
    `;
  } else {
    // Group by category
    const categoriesMap = {};
    toPickItems.forEach(item => {
      const cat = item.category_name || "Uncategorized";
      if (!categoriesMap[cat]) categoriesMap[cat] = [];
      categoriesMap[cat].push(item);
    });

    // Sort categories alphabetically
    const sortedCategories = Object.keys(categoriesMap).sort();

    sortedCategories.forEach(catName => {
      const catItems = categoriesMap[catName];
      // Sort items within category alphabetically
      catItems.sort((a, b) => a.item_name.localeCompare(b.item_name));

      const groupDiv = document.createElement("div");
      groupDiv.className = "category-group";
      groupDiv.innerHTML = `
        <div class="category-header">
          <span>${catName}</span>
          <span class="category-count">${catItems.length} items</span>
        </div>
      `;

      catItems.forEach(item => {
        const itemEl = createProductCard(item);
        groupDiv.appendChild(itemEl);
      });

      toPickContainer.appendChild(groupDiv);
    });
  }

  // --- Render Picked (Sorted by recency of check action) ---
  const pickedContainer = document.getElementById("picked-list");
  pickedContainer.innerHTML = "";

  if (pickedItems.length === 0) {
    pickedContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📥</div>
        <h3>No Items Picked</h3>
        <p>Checked items will display here immediately.</p>
      </div>
    `;
  } else {
    // Sort picked items: recently picked IDs at the top
    pickedItems.sort((a, b) => {
      const idxA = state.recentPickedIds.indexOf(a.id);
      const idxB = state.recentPickedIds.indexOf(b.id);
      
      // If both are in recent list, sort by recency order (index DESC)
      if (idxA !== -1 && idxB !== -1) return idxB - idxA;
      // If only one is in recent list, that one goes first
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      
      // Fallback: alphabetical
      return a.item_name.localeCompare(b.item_name);
    });

    pickedItems.forEach(item => {
      const itemEl = createProductCard(item);
      pickedContainer.appendChild(itemEl);
    });
  }
}

// Generate Product DOM Component
function createProductCard(item) {
  const card = document.createElement("div");
  
  // Highlight card borders if quantities differ (over-picked vs under-picked)
  let diffClass = "";
  if (item.loaded_qty > item.required_qty) {
    diffClass = "over-picked";
  } else if (item.loaded_qty < item.required_qty) {
    diffClass = "under-picked";
  }

  card.className = `product-card ${item.is_picked ? 'picked' : ''} ${diffClass}`;
  card.id = `prod-card-${item.id}`;

  const imageSrc = item.image_path 
    ? `https://curtiss.suzxlabs.com/${item.image_path.replace(/^\/+/, '')}`
    : null;

  card.innerHTML = `
    <div class="product-img-box">
      ${imageSrc 
        ? `<img src="${imageSrc}" alt="${item.item_name}" onerror="this.outerHTML='<span class=\\'img-fallback\\'>📦</span>'">` 
        : `<span class="img-fallback">📦</span>`}
    </div>
    <div class="product-info">
      <div class="product-name">${item.item_name}</div>
      <div class="qty-req">Required: <strong>${item.required_qty}</strong> pcs</div>
    </div>
    <div class="qty-adjuster">
      <button class="qty-btn btn-minus" type="button">−</button>
      <div class="qty-input-wrapper">
        <input class="qty-input" type="number" min="0" value="${item.loaded_qty}">
      </div>
      <button class="qty-btn btn-plus" type="button">+</button>
    </div>
    <div class="pick-checkbox-wrapper">
      <div class="pick-checkbox"></div>
    </div>
  `;

  // --- Attach Handlers ---
  const imgBox = card.querySelector(".product-img-box");
  imgBox.addEventListener("click", (e) => {
    e.stopPropagation();
    openImageModal(item.item_name, imageSrc);
  });

  const qtyInput = card.querySelector(".qty-input");
  const btnMinus = card.querySelector(".btn-minus");
  const btnPlus = card.querySelector(".btn-plus");
  const checkbox = card.querySelector(".pick-checkbox");

  // Quantity updates
  const updateQty = (newVal) => {
    newVal = Math.max(0, parseFloat(newVal) || 0);
    qtyInput.value = newVal;
    item.loaded_qty = newVal;
    
    // Adjust visual indicators
    card.classList.remove("over-picked", "under-picked");
    if (newVal > item.required_qty) {
      card.classList.add("over-picked");
    } else if (newVal < item.required_qty) {
      card.classList.add("under-picked");
    }

    queueItemUpdate(item);
  };

  btnMinus.addEventListener("click", (e) => {
    e.stopPropagation();
    updateQty(item.loaded_qty - 1);
  });

  btnPlus.addEventListener("click", (e) => {
    e.stopPropagation();
    updateQty(item.loaded_qty + 1);
  });

  qtyInput.addEventListener("change", () => {
    updateQty(qtyInput.value);
  });

  qtyInput.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // Ticking / Checking logic
  checkbox.addEventListener("click", (e) => {
    e.stopPropagation();
    
    if (item.is_picked === 0) {
      item.is_picked = 1;
      card.classList.add("picked");
      
      // Add to recent list
      if (!state.recentPickedIds.includes(item.id)) {
        state.recentPickedIds.push(item.id);
      }
    } else {
      item.is_picked = 0;
      card.classList.remove("picked");
      
      // Remove from recent list
      state.recentPickedIds = state.recentPickedIds.filter(id => id !== item.id);
    }

    queueItemUpdate(item);
    
    // Animate removal and trigger UI refresh immediately
    card.style.transform = "scale(0.92)";
    card.style.opacity = "0";
    setTimeout(() => {
      renderPickingUI();
    }, 200);
  });

  return card;
}

// --- 8. IMAGE PREVIEW MODAL ---
function openImageModal(name, src) {
  const modal = document.getElementById("image-modal");
  const modalName = document.getElementById("modal-product-name");
  const modalImg = document.getElementById("modal-image");

  modalName.innerText = name;
  if (src) {
    modalImg.src = src;
    modalImg.style.display = "block";
  } else {
    modalImg.src = "";
    modalImg.style.display = "none";
  }
  
  modal.style.display = "flex";
}

function closeImageModal() {
  document.getElementById("image-modal").style.display = "none";
}

// --- PRODUCT REPLACEMENT FUNCTIONS ---
function openReplaceProductModal(item) {
  if (!state.isOnline) {
    alert("Product replacement requires an active internet connection.");
    return;
  }
  
  state.originalItemToReplace = item;
  state.selectedReplacementProduct = null;
  
  document.getElementById("replace-orig-name").innerText = item.item_name;
  document.getElementById("replace-orig-qty").innerText = item.required_qty;
  
  document.getElementById("replacement-search-input").value = "";
  document.getElementById("replacement-search-results").innerHTML = "";
  document.getElementById("replacement-search-results").style.display = "none";
  document.getElementById("selected-replacement-box").style.display = "none";
  
  document.getElementById("replacement-qty-input").value = item.required_qty;
  
  const modal = document.getElementById("replace-product-modal");
  if (modal) modal.style.display = "flex";
}

function closeReplaceProductModal() {
  const modal = document.getElementById("replace-product-modal");
  if (modal) modal.style.display = "none";
  state.originalItemToReplace = null;
  state.selectedReplacementProduct = null;
}

let replacementSearchTimeout = null;
function handleReplacementSearch() {
  const q = document.getElementById("replacement-search-input").value.trim();
  const resultsDiv = document.getElementById("replacement-search-results");
  
  if (q.length < 2) {
    resultsDiv.innerHTML = "";
    resultsDiv.style.display = "none";
    return;
  }
  
  if (replacementSearchTimeout) clearTimeout(replacementSearchTimeout);
  
  replacementSearchTimeout = setTimeout(() => {
    fetchSecure(`${API_BASE}/api_search_products?q=${encodeURIComponent(q)}`)
      .then(res => res.json())
      .then(data => {
        if (data.success && data.products) {
          resultsDiv.innerHTML = "";
          if (data.products.length === 0) {
            resultsDiv.innerHTML = '<div style="padding: 10px; color: var(--text-secondary); text-align: center; font-size:12px;">No products found</div>';
          } else {
            data.products.forEach(p => {
              const itemDiv = document.createElement("div");
              itemDiv.style.padding = "10px";
              itemDiv.style.cursor = "pointer";
              itemDiv.style.borderBottom = "1px solid var(--border-color)";
              itemDiv.style.fontSize = "13px";
              itemDiv.style.color = "var(--text-primary)";
              itemDiv.innerHTML = `<strong>${p.name}</strong> <span style="font-size:11px; color:var(--text-secondary);">(${p.item_code})</span>`;
              itemDiv.addEventListener("click", () => {
                selectReplacementProduct(p);
              });
              resultsDiv.appendChild(itemDiv);
            });
          }
          resultsDiv.style.display = "block";
        }
      });
  }, 300);
}

function selectReplacementProduct(product) {
  state.selectedReplacementProduct = product;
  document.getElementById("selected-repl-name").innerText = `${product.name} (${product.item_code})`;
  document.getElementById("selected-replacement-box").style.display = "block";
  document.getElementById("replacement-search-results").style.display = "none";
  document.getElementById("replacement-search-input").value = product.name;
}

function saveReplacement() {
  if (!state.originalItemToReplace) {
    alert("No original product selected.");
    return;
  }
  if (!state.selectedReplacementProduct) {
    alert("Please search and select a replacement product.");
    return;
  }
  
  const qty = parseFloat(document.getElementById("replacement-qty-input").value);
  if (isNaN(qty) || qty <= 0) {
    alert("Please enter a valid quantity.");
    return;
  }
  
  const payload = {
    delivery_id: state.activeSheet.id,
    original_item_id: state.originalItemToReplace.item_id,
    replacement_item_id: state.selectedReplacementProduct.id,
    replacement_qty: qty,
    user_id: state.currentUser ? state.currentUser.id : null
  };
  
  fetchSecure(`${API_BASE}/api_substitute_product`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        alert("Product substitution saved successfully.");
        closeReplaceProductModal();
        openFinalLoadingSheet(state.activeSheet);
      } else {
        alert("Error: " + data.error);
      }
    })
    .catch(err => {
      console.error(err);
      alert("Failed to save product substitution.");
    });
}

// Helper to safely register event listener if element exists
function safeAddListener(id, event, callback) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener(event, callback);
  }
}

// --- 9. EVENT LISTENERS SETUP ---
function setupEventListeners() {
  // Authentication Flow
  safeAddListener("login-form", "submit", handleLogin);
  safeAddListener("logout-btn", "click", handleLogout);

  // Navigation / Back button
  safeAddListener("btn-back-to-sheets", "click", () => {
    // Clear details and reload list
    state.activeSheet = null;
    state.activeSheetItems = [];
    state.recentPickedIds = [];
    showView("view-sheets");
    loadSheets(true);
  });

  safeAddListener("btn-back-to-sheets-final", "click", () => {
    state.activeSheet = null;
    state.activeSheetItems = [];
    showView("view-sheets");
    loadSheets(true);
  });

  // Action Modal controls
  safeAddListener("action-modal-close", "click", () => {
    const modal = document.getElementById("action-modal");
    if (modal) modal.style.display = "none";
  });
  
  safeAddListener("action-modal", "click", (e) => {
    if (e.target.id === "action-modal") {
      e.target.style.display = "none";
    }
  });

  safeAddListener("opt-stage1", "click", () => {
    const modal = document.getElementById("action-modal");
    if (modal) modal.style.display = "none";
    if (state.activeSheet) {
      openPickingSheet(state.activeSheet);
    }
  });

  safeAddListener("opt-stage2", "click", () => {
    const modal = document.getElementById("action-modal");
    if (modal) modal.style.display = "none";
    if (state.activeSheet) {
      openFinalLoadingSheet(state.activeSheet);
    }
  });

  // Search input listeners
  safeAddListener("search-sheets", "input", () => renderSheetsUI(state.sheets));
  safeAddListener("filter-status", "change", () => renderSheetsUI(state.sheets));
  
  safeAddListener("search-products", "input", () => renderPickingUI());
  safeAddListener("search-products-final", "input", () => renderFinalLoadingUI());

  // Tabs click events
  safeAddListener("tab-to-pick", "click", () => switchTab("to-pick"));
  safeAddListener("tab-picked", "click", () => switchTab("picked"));

  // Manual Sync trigger
  safeAddListener("sync-btn", "click", () => {
    if (!state.isOnline) {
      alert("Cannot sync: device is currently offline.");
      return;
    }
    syncOfflineData();
  });

  // Image modal closing
  safeAddListener("modal-close", "click", closeImageModal);
  safeAddListener("image-modal", "click", (e) => {
    if (e.target.id === "image-modal") {
      closeImageModal();
    }
  });

  // Product Replacement Modal closing & listeners
  safeAddListener("replace-modal-close", "click", closeReplaceProductModal);
  safeAddListener("replace-product-modal", "click", (e) => {
    if (e.target.id === "replace-product-modal") {
      closeReplaceProductModal();
    }
  });
  safeAddListener("replacement-search-input", "input", handleReplacementSearch);
  safeAddListener("btn-save-replacement", "click", saveReplacement);
}
