import { Component, inject, OnDestroy } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { FormsModule } from "@angular/forms";
import { CommonModule } from "@angular/common";
import { HttpClient, HttpClientModule, HttpErrorResponse, HttpHeaders } from "@angular/common/http";

interface ApiError {
  message?: string;
}
interface LoginResponse {
  accessToken?: string;
  token?: string;
}
interface OnlinePeer {
  peerId: string;
  name: string;
  kind: string;
  version: string;
  lastSeen: number;
  traffic?: { p2p: TrafficDirection; mqtt: TrafficDirection };
}
interface TrafficDirection {
  tx: { bytes: number };
  rx: { bytes: number };
}
interface AdminStats {
  online: number;
  presence: OnlinePeer[];
  users: number;
  peers: number;
  revoked: number;
  grants: number;
  brokerHealthy: boolean;
  traffic: { presence: number };
}
interface AdminUser {
  id: string;
  username: string;
  role: string;
  status: "ACTIVE" | "DISABLED";
}
interface AdminPeer {
  id: string;
  peerId: string;
  name?: string;
  status: string;
  user?: { id: string; username: string };
  grant?: { status: string };
}
interface NewUser {
  username: string;
  password: string;
  role: "USER" | "ADMIN";
}

@Component({
  selector: "admin-root",
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule],
  template: ` <main class="shell">
    <header>
      <div>
        <span class="brand">🔗 p2plink</span>
        <h1>Registry <em>Admin</em></h1>
        <p>Control room for your peer network</p>
      </div>
      <div class="actions" *ngIf="token">
        <label class="check"
          ><input type="checkbox" [(ngModel)]="autoRefresh" /> Auto-refresh every 30 seconds</label
        >
        <button class="secondary" (click)="load()">↻ Refresh</button
        ><button class="danger" (click)="logout()">↪ Logout</button>
      </div>
    </header>
    <section class="login panel" *ngIf="!token">
      <h2>👋 Welcome back</h2>
      <p>Sign in with your registry account.</p>
      <form (ngSubmit)="login()">
        <label
          >Username<input
            name="username"
            [(ngModel)]="username"
            required
            autocomplete="username" /></label
        ><label
          >Password<input
            name="password"
            [(ngModel)]="password"
            type="password"
            required
            autocomplete="current-password" /></label
        ><button class="primary">🔐 Sign in</button>
      </form>
      <p class="error" *ngIf="error">{{ error }}</p>
    </section>
    <section *ngIf="token && forbidden" class="panel denied">
      <h2>🚫 Not an admin</h2>
      <p>Your account does not have administrator access.</p>
      <button class="danger" (click)="logout()">↪ Logout</button>
    </section>
    <div *ngIf="token && !forbidden">
      <p class="error" *ngIf="error">{{ error }}</p>
      <section class="stats">
        <article class="stat c1">
          <small>👤 Users</small><strong>{{ stats?.users ?? "—" }}</strong>
        </article>
        <article class="stat c2">
          <small>🛰️ Peers</small><strong>{{ stats?.peers ?? "—" }}</strong>
        </article>
        <article class="stat c3">
          <small>⛔ Revoked</small><strong>{{ stats?.revoked ?? "—" }}</strong>
        </article>
        <article class="stat c4">
          <small>🎟️ Grants</small><strong>{{ stats?.grants ?? "—" }}</strong>
        </article>
        <article class="stat c5">
          <small>📡 Broker</small><strong>{{ stats?.brokerHealthy ? "Online" : "Offline" }}</strong>
        </article>
        <article class="stat c6">
          <small>🟢 Online now</small><strong>{{ stats?.online ?? "—" }}</strong>
        </article>
      </section>
      <section class="panel online-panel">
        <h2>🟢 Online now</h2>
        <p class="traffic-note">Traffic totals are reported by client (bytes; not rates).</p>
        <div class="tablewrap" *ngIf="stats?.presence?.length; else noOnline">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Peer ID</th>
                <th>Kind</th>
                <th>Version</th>
                <th>Last seen</th>
                <th>Reported P2P tx/rx</th>
                <th>Reported MQTT tx/rx</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let p of stats.presence">
                <td>{{ p.name }}</td>
                <td>{{ p.peerId }}</td>
                <td>{{ p.kind }}</td>
                <td>{{ p.version }}</td>
                <td>{{ p.lastSeen | date: "medium" }}</td>
                <td>
                  {{ formatBytes(p.traffic?.p2p?.tx?.bytes ?? 0) }} /
                  {{ formatBytes(p.traffic?.p2p?.rx?.bytes ?? 0) }}
                </td>
                <td>
                  {{ formatBytes(p.traffic?.mqtt?.tx?.bytes ?? 0) }} /
                  {{ formatBytes(p.traffic?.mqtt?.rx?.bytes ?? 0) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <ng-template #noOnline><p>No peers online right now.</p></ng-template>
      </section>
      <div class="columns">
        <section class="panel">
          <h2>👥 Users</h2>
          <div class="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr
                  *ngFor="let u of users"
                  (click)="selectUser(u)"
                  [class.selected]="selectedUser?.id === u.id"
                >
                  <td>{{ u.username }}</td>
                  <td>{{ u.role }}</td>
                  <td>
                    <span class="badge">{{ u.status }}</span>
                  </td>
                  <td>
                    <button class="tiny" (click)="setUserStatus(u); $event.stopPropagation()">
                      {{ u.status === "ACTIVE" ? "Disable" : "Enable" }}
                    </button>
                    <button class="tiny revoke" (click)="deleteUser(u); $event.stopPropagation()">
                      Delete
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <h3>✨ Create user</h3>
          <form class="create" (ngSubmit)="createUser()">
            <input
              name="newUsername"
              [(ngModel)]="newUser.username"
              placeholder="Username"
              required
              minlength="2"
            /><input
              name="newPassword"
              [(ngModel)]="newUser.password"
              placeholder="Password (min 8)"
              type="password"
              required
              minlength="8"
            /><select name="role" [(ngModel)]="newUser.role">
              <option value="USER">USER</option>
              <option value="ADMIN">ADMIN</option></select
            ><button class="primary">＋ Create</button>
          </form>
        </section>
        <section class="panel">
          <h2>🛰️ Clients{{ selectedUser ? " for " + selectedUser.username : "" }}</h2>
          <p *ngIf="!selectedUser">Select a user to view their clients.</p>
          <p class="traffic-note">Traffic totals are reported by client (bytes; not rates).</p>
          <div class="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Peer ID</th>
                  <th>Name</th>
                  <th>User</th>
                  <th>Status</th>
                  <th>Broker grant</th>
                  <th>Reported P2P tx/rx bytes</th>
                  <th>Reported MQTT tx/rx bytes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let p of selectedPeers">
                  <td>{{ p.peerId }}</td>
                  <td>{{ p.name || "—" }}</td>
                  <td>{{ p.user?.username || "—" }}</td>
                  <td>
                    <span class="badge">{{ p.status }}</span>
                  </td>
                  <td>{{ p.grant?.status || "—" }}</td>
                  <td>
                    {{ formatBytes(trafficFor(p.peerId)?.p2p?.tx?.bytes ?? 0) }} /
                    {{ formatBytes(trafficFor(p.peerId)?.p2p?.rx?.bytes ?? 0) }}
                  </td>
                  <td>
                    {{ formatBytes(trafficFor(p.peerId)?.mqtt?.tx?.bytes ?? 0) }} /
                    {{ formatBytes(trafficFor(p.peerId)?.mqtt?.rx?.bytes ?? 0) }}
                  </td>
                  <td>
                    <button class="tiny revoke" (click)="deletePeer(p)">⛔ Delete</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  </main>`,
  styles: [],
})
class AdminApp implements OnDestroy {
  private http = inject(HttpClient);
  token = sessionStorage.getItem("admin-token") || "";
  username = "";
  password = "";
  error = "";
  forbidden = false;
  stats?: AdminStats;
  users: AdminUser[] = [];
  peers: AdminPeer[] = [];
  newUser: NewUser = { username: "", password: "", role: "USER" };
  autoRefresh = true;
  selectedUser?: AdminUser;
  private timer = setInterval(() => {
    if (this.autoRefresh) this.load();
  }, 30_000);
  private loading = false;
  ngOnDestroy() {
    clearInterval(this.timer);
  }
  get selectedPeers() {
    return this.selectedUser ? this.peers.filter((p) => p.user?.id === this.selectedUser?.id) : [];
  }
  selectUser(user: AdminUser) {
    this.selectedUser = user;
  }
  trafficFor(peerId: string) {
    return this.stats?.presence.find((p) => p.peerId === peerId)?.traffic;
  }
  formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = -1;
    do {
      value /= 1024;
      unit += 1;
    } while (value >= 1024 && unit < units.length - 1);
    return `${value.toFixed(1)} ${units[unit]}`;
  }
  login() {
    this.error = "";
    this.http
      .post<LoginResponse>("/v1/auth/login", { username: this.username, password: this.password })
      .subscribe({
        next: (r) => {
          this.token = r.accessToken || r.token || "";
          sessionStorage.setItem("admin-token", this.token);
          this.load();
        },
        error: (e: HttpErrorResponse) => (this.error = this.message(e)),
      });
  }
  load() {
    if (this.loading || !this.token) return;
    this.loading = true;
    this.forbidden = false;
    const headers = new HttpHeaders({ Authorization: `Bearer ${this.token}` });
    this.http.get<AdminStats>("/v1/admin/stats", { headers }).subscribe({
      next: (r) => {
        this.stats = r;
        this.loading = false;
        this.error = "";
        this.fetchTables(headers);
      },
      error: (e: HttpErrorResponse) => {
        this.loading = false;
        if (e.status === 403) this.forbidden = true;
        else if (e.status === 401) this.logout();
        else this.error = this.message(e);
      },
    });
  }
  fetchTables(headers: HttpHeaders) {
    this.http.get<AdminUser[]>("/v1/admin/users", { headers }).subscribe({
      next: (r) => (this.users = r),
      error: (e: HttpErrorResponse) => (this.error = this.message(e)),
    });
    this.http.get<AdminPeer[]>("/v1/admin/peers", { headers }).subscribe({
      next: (r) => (this.peers = r),
      error: (e: HttpErrorResponse) => (this.error = this.message(e)),
    });
  }
  createUser() {
    this.http
      .post("/v1/admin/users", this.newUser, { headers: { Authorization: `Bearer ${this.token}` } })
      .subscribe({
        next: () => {
          this.newUser = { username: "", password: "", role: "USER" };
          this.load();
        },
        error: (e: HttpErrorResponse) => (this.error = this.message(e)),
      });
  }
  setUserStatus(u: AdminUser) {
    const status = u.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    this.http
      .patch(
        `/v1/admin/users/${u.id}/status`,
        { status },
        { headers: { Authorization: `Bearer ${this.token}` } },
      )
      .subscribe({
        next: () => this.load(),
        error: (e: HttpErrorResponse) => (this.error = this.message(e)),
      });
  }
  deletePeer(p: AdminPeer) {
    if (
      !confirm(
        `Delete client ${p.peerId}? This removes the client and forces its user to sign in again.`,
      )
    )
      return;
    this.http
      .delete(`/v1/admin/peers/${p.id}`, { headers: { Authorization: `Bearer ${this.token}` } })
      .subscribe({
        next: () => this.load(),
        error: (e: HttpErrorResponse) => (this.error = this.message(e)),
      });
  }
  deleteUser(u: AdminUser) {
    if (!confirm(`Delete user ${u.username} and all their clients and sessions?`)) return;
    this.http
      .delete(`/v1/admin/users/${u.id}`, { headers: { Authorization: `Bearer ${this.token}` } })
      .subscribe({
        next: () => {
          if (this.selectedUser?.id === u.id) this.selectedUser = undefined;
          this.load();
        },
        error: (e: HttpErrorResponse) => (this.error = this.message(e)),
      });
  }
  logout() {
    this.token = "";
    this.forbidden = false;
    sessionStorage.removeItem("admin-token");
  }
  private message(e: HttpErrorResponse) {
    return (e.error as ApiError | null)?.message || "Request failed. Please try again.";
  }
}
bootstrapApplication(AdminApp).catch(console.error);
