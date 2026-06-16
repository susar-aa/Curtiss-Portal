// PWA Core Logic & State Management
const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.hostname.startsWith("192.168.")
  ? window.location.origin + "/Curtiss-ERP/Picking"
  : "https://curtiss.suzxlabs.com/picking";

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

  fetch(`${API_BASE}/api_sync`, {
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
document.getElementById("login-form").addEventListener("submit", (e) => {
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
});

document.getElementById("logout-btn").addEventListener("click", () => {
  state.currentUser = null;
  localStorage.removeItem("curtiss_picking_user");
  showView("view-login");
});

// --- 6. LOADING SHEETS CONTROLLER ---
function loadSheets(quiet = false) {
  const spinner = document.getElementById("sheets-loading-spinner");
  const emptyState = document.getElementById("sheets-empty-state");
  const listContainer = document.getElementById("sheets-list");

  if (!quiet) {
    spinner.style.display = "flex";
    listContainer.innerHTML = "";
  }
  emptyState.style.display = "none";

  const renderLocalData = () => {
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

  fetch(`${API_BASE}/api_get_sheets`)
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        state.sheets = data.sheets;
        localStorage.setItem("curtiss_picking_sheets", JSON.stringify(data.sheets));
        renderSheetsUI(data.sheets);
      } else {
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
  const listContainer = document.getElementById("sheets-list");
  listContainer.innerHTML = "";

  const searchVal = document.getElementById("search-sheets").value.toLowerCase();
  const statusFilter = document.getElementById("filter-status").value;

  const filtered = sheets.filter(sheet => {
    const matchesSearch = 
      sheet.id.toString().includes(searchVal) ||
      sheet.route_name.toLowerCase().includes(searchVal) ||
      sheet.vehicle_number.toLowerCase().includes(searchVal) ||
      sheet.driver_name.toLowerCase().includes(searchVal) ||
      sheet.customer_info.toLowerCase().includes(searchVal);

    const matchesStatus = statusFilter === "all" || sheet.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

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
    card.innerHTML = `
      <div class="manifest-card-header">
        <h3>Loading Sheet #${sheet.id}</h3>
        <span class="manifest-status ${sheet.status.toLowerCase().replace(' ', '-')}">${sheet.status}</span>
      </div>
      <div class="manifest-info-row">
        <span>📍 <strong>Route:</strong> ${sheet.route_name}</span>
        <span>👥 <strong>Customers:</strong> ${sheet.customer_info}</span>
        <span>🚚 <strong>Vehicle:</strong> ${sheet.vehicle_number} (${sheet.driver_name})</span>
        <span>📅 <strong>Delivery Date:</strong> ${sheet.delivery_date}</span>
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
      openFinalLoadingSheet(sheet);
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

  fetch(`${API_BASE}/api_get_sheet_details/${sheet.id}`)
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

  fetch(`${API_BASE}/api_get_sheet_details/${sheet.id}`)
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
        <div style="margin-top: 4px;">
          <span class="variance-tag ${varClass}">${varLabel}</span>
        </div>
      </div>
      <div class="qty-adjuster">
        <button class="qty-btn btn-minus" type="button">−</button>
        <div class="qty-input-wrapper">
          <input class="qty-input" type="number" min="0" value="${item.final_loaded_qty}">
        </div>
        <button class="qty-btn btn-plus" type="button">+</button>
      </div>
      <div style="padding-left: 8px;">
        <button class="btn-verify ${item.is_verified ? 'verified' : ''}">${item.is_verified ? 'Verified ✓' : 'Verify'}</button>
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

// --- 9. EVENT LISTENERS SETUP ---
function setupEventListeners() {
  // Navigation / Back button
  document.getElementById("btn-back-to-sheets").addEventListener("click", () => {
    // Clear details and reload list
    state.activeSheet = null;
    state.activeSheetItems = [];
    state.recentPickedIds = [];
    showView("view-sheets");
    loadSheets(true);
  });

  document.getElementById("btn-back-to-sheets-final").addEventListener("click", () => {
    state.activeSheet = null;
    state.activeSheetItems = [];
    showView("view-sheets");
    loadSheets(true);
  });

  // Action Modal controls
  document.getElementById("action-modal-close").addEventListener("click", () => {
    document.getElementById("action-modal").style.display = "none";
  });
  document.getElementById("action-modal").addEventListener("click", (e) => {
    if (e.target.id === "action-modal") {
      document.getElementById("action-modal").style.display = "none";
    }
  });

  document.getElementById("opt-stage1").addEventListener("click", () => {
    document.getElementById("action-modal").style.display = "none";
    if (state.activeSheet) {
      openPickingSheet(state.activeSheet);
    }
  });

  document.getElementById("opt-stage2").addEventListener("click", () => {
    document.getElementById("action-modal").style.display = "none";
    if (state.activeSheet) {
      openFinalLoadingSheet(state.activeSheet);
    }
  });

  // Search input listeners
  document.getElementById("search-sheets").addEventListener("input", () => renderSheetsUI(state.sheets));
  document.getElementById("filter-status").addEventListener("change", () => renderSheetsUI(state.sheets));
  
  document.getElementById("search-products").addEventListener("input", () => renderPickingUI());
  document.getElementById("search-products-final").addEventListener("input", () => renderFinalLoadingUI());

  // Tabs click events
  document.getElementById("tab-to-pick").addEventListener("click", () => switchTab("to-pick"));
  document.getElementById("tab-picked").addEventListener("click", () => switchTab("picked"));

  // Manual Sync trigger
  document.getElementById("sync-btn").addEventListener("click", () => {
    if (!state.isOnline) {
      alert("Cannot sync: device is currently offline.");
      return;
    }
    syncOfflineData();
  });

  // Image modal closing
  document.getElementById("modal-close").addEventListener("click", closeImageModal);
  document.getElementById("image-modal").addEventListener("click", (e) => {
    if (e.target.id === "image-modal") {
      closeImageModal();
    }
  });
}
