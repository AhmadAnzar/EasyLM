import { createContext, useContext } from 'react'

// { user: {username, workspaces} | null, login, register, logout, addWorkspace }
export const AuthContext = createContext(null)

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
