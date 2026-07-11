import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App', () => {
  it('renders the title screen and starts a shift', async () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: '零点接线台' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '开始值班' }))

    expect(await screen.findByText('第 1/5 通来电')).toBeInTheDocument()
    const answerButton = screen.getByRole('button', { name: '接 听 电 话' })
    expect(answerButton).toBeInTheDocument()

    fireEvent.click(answerButton)

    expect(await screen.findByText('待判定')).toBeInTheDocument()
    expect(screen.queryByText(/^(HOT|COLD)$/)).not.toBeInTheDocument()
  })
})
