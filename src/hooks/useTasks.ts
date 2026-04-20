import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export interface Task {
  id: string
  business_id?: string
  user_id?: string
  title: string
  description?: string
  due_date?: string
  priority: 'low' | 'medium' | 'high' | 'urgent'
  status: 'pending' | 'completed'
  completed_at?: string | null
  created_at: string
  updated_at: string
}

export function useTasks(businessId?: string) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadTasks()
  }, [businessId])

  const loadTasks = async () => {
    try {
      setLoading(true)
      setError(null)

      let query = supabase
        .from('tasks')
        .select('*')
        .order('due_date', { ascending: true, nullsFirst: false })
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false })

      if (businessId) {
        query = query.eq('business_id', businessId)
      }

      const { data, error } = await query

      if (error) throw error

      setTasks(data || [])
    } catch (err) {
      console.error('Error al cargar tareas:', err)
      setError('Error al cargar tareas')
    } finally {
      setLoading(false)
    }
  }

  const createTask = async (task: Omit<Task, 'id' | 'created_at' | 'updated_at' | 'completed_at'>) => {
    try {
      const { data, error } = await supabase
        .from('tasks')
        .insert({
          ...task,
          due_date: task.due_date || null,
          description: task.description || null,
          business_id: businessId,
          status: 'pending'
        })
        .select()
        .single()

      if (error) throw error

      setTasks(prev => [data, ...prev])
      return data
    } catch (err) {
      console.error('Error al crear tarea:', err)
      throw err
    }
  }

  const updateTask = async (id: string, updates: Partial<Task>) => {
    try {
      const { data, error } = await supabase
        .from('tasks')
        .update({
          ...updates,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single()

      if (error) throw error

      setTasks(prev => prev.map(t => t.id === id ? data : t))
      return data
    } catch (err) {
      console.error('Error al actualizar tarea:', err)
      throw err
    }
  }

  const toggleTaskStatus = async (id: string) => {
    const task = tasks.find(t => t.id === id)
    if (!task) return

    const newStatus = task.status === 'pending' ? 'completed' : 'pending'
    const updates: Partial<Task> = {
      status: newStatus,
      completed_at: newStatus === 'completed' ? new Date().toISOString() : null
    }

    await updateTask(id, updates)
  }

  const deleteTask = async (id: string) => {
    try {
      const { error } = await supabase
        .from('tasks')
        .delete()
        .eq('id', id)

      if (error) throw error

      setTasks(prev => prev.filter(t => t.id !== id))
    } catch (err) {
      console.error('Error al eliminar tarea:', err)
      throw err
    }
  }

  const pendingTasks = tasks.filter(t => t.status === 'pending')
  const completedTasks = tasks.filter(t => t.status === 'completed')

  return {
    tasks,
    pendingTasks,
    completedTasks,
    loading,
    error,
    createTask,
    updateTask,
    toggleTaskStatus,
    deleteTask,
    refresh: loadTasks
  }
}
