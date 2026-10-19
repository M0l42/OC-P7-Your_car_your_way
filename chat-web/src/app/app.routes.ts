import { Routes } from '@angular/router';
import { AgentPage } from './pages/agent-page';
import { CustomerPage } from './pages/customer-page';

export const routes: Routes = [
  { path: '', component: CustomerPage, title: 'Chat — client' },
  { path: 'agent', component: AgentPage, title: 'Chat — agent' },
  { path: '**', redirectTo: '' },
];
