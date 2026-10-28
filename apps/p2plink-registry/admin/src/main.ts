import { Component, inject } from "@angular/core";
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
interface AdminStats {
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
  isAdmin: boolean;
  status: "ACTIVE" | "DISABLED";
}
interface AdminPeer {
  id: string;
  peerId: string;
  name?: string;
  status: string;
  user?: { username: string };
  grant?: { status: string };
}
interface NewUser {
  username: string;
  password: string;
  role: "USER" | "ADMIN";
  isAdmin: boolean;
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
          <small>🟢 Active presence</small><strong>{{ stats?.traffic?.presence ?? "—" }}</strong>
        </article>
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
                  <th>Admin</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let u of users">
                  <td>{{ u.username }}</td>
                  <td>{{ u.role }}</td>
                  <td>{{ u.isAdmin ? "Yes" : "No" }}</td>
                  <td>
                    <span class="badge">{{ u.status }}</span>
                  </td>
                  <td>
                    <button class="tiny" (click)="setUserStatus(u)">
                      {{ u.status === "ACTIVE" ? "Disable" : "Enable" }}
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
            ><label class="check"
              ><input type="checkbox" name="isAdmin" [(ngModel)]="newUser.isAdmin" /> Admin
              access</label
            ><button class="primary">＋ Create</button>
          </form>
        </section>
        <section class="panel">
          <h2>🛰️ Peers &amp; clients</h2>
          <div class="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Peer ID</th>
                  <th>Name</th>
                  <th>User</th>
                  <th>Status</th>
                  <th>Broker grant</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let p of peers">
                  <td>{{ p.peerId }}</td>
                  <td>{{ p.name || "—" }}</td>
                  <td>{{ p.user?.username || "—" }}</td>
                  <td>
                    <span class="badge">{{ p.status }}</span>
                  </td>
                  <td>{{ p.grant?.status || "—" }}</td>
                  <td>
                    <button
                      class="tiny revoke"
                      [disabled]="p.status === 'REVOKED'"
                      (click)="revoke(p)"
                    >
                      ⛔ Revoke
                    </button>
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
class AdminApp {
  private http = inject(HttpClient);
  token = sessionStorage.getItem("admin-token") || "";
  username = "";
  password = "";
  error = "";
  forbidden = false;
  stats?: AdminStats;
  users: AdminUser[] = [];
  peers: AdminPeer[] = [];
  newUser: NewUser = { username: "", password: "", role: "USER", isAdmin: false };
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
    this.forbidden = false;
    const headers = new HttpHeaders({ Authorization: `Bearer ${this.token}` });
    this.http.get<AdminStats>("/v1/admin/stats", { headers }).subscribe({
      next: (r) => {
        this.stats = r;
        this.error = "";
        this.fetchTables(headers);
      },
      error: (e: HttpErrorResponse) => {
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
          this.newUser = { username: "", password: "", role: "USER", isAdmin: false };
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
  revoke(p: AdminPeer) {
    if (!confirm(`Revoke peer ${p.peerId}?`)) return;
    this.http
      .patch(
        `/v1/admin/peers/${p.id}/revoke`,
        {},
        { headers: { Authorization: `Bearer ${this.token}` } },
      )
      .subscribe({
        next: () => this.load(),
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
